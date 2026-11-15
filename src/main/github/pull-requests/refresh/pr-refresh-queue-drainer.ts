import { PRRefreshRecoveryLifecycle } from './pr-refresh-recovery-lifecycle'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  freshQueuedPROutcome,
  isBackground,
  validateCandidate,
  refreshKey
} from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue } from './pr-refresh-queue'
import { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import { prRefreshRequestDigest, queuedRequestId } from './pr-refresh-request-registry'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import { HostedPRReadJobs } from './hosted-pr-read-jobs'
import { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'
import { readQueuedPRRefresh } from './pr-refresh-queued-read'
import { PRRefreshAdmission } from './pr-refresh-admission'

export type PRRefreshRegistrationCheck = (candidate: GitHubPRRefreshCandidate) => boolean

export class PRRefreshQueueDrainer extends PRRefreshRecoveryLifecycle {
  private draining = false
  registrationCheck: PRRefreshRegistrationCheck | null = null
  readonly watchJobs: PRWatchJobRunner
  readonly hostedJobs: HostedPRReadJobs
  readonly scheduler: PRRefreshQueueScheduler
  private readonly admission: PRRefreshAdmission

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher
  ) {
    super()
    this.watchJobs = new PRWatchJobRunner(queue, retry, this)
    this.scheduler = new PRRefreshQueueScheduler(
      queue,
      pacing,
      visibility,
      retry,
      events,
      this.watchJobs,
      () => {
        this.tickRecovery((delay) => this.schedule(delay))
        return this.drain()
      }
    )
    this.admission = new PRRefreshAdmission(queue, pacing, visibility, retry, events, this)
    this.hostedJobs = new HostedPRReadJobs(
      queue,
      pacing,
      retry,
      () => this.schedule(),
      (candidate, outcome) => events.observe(candidate, outcome),
      (entry) => {
        const requestId = queuedRequestId(entry)
        this.requests.start({
          requestId,
          slotKey: refreshKey(entry.candidate),
          registrationOrder: entry.queuedAt,
          identityDigest: prRefreshRequestDigest(entry.candidate)
        })
        return () => this.requests.settle(requestId)
      }
    )
  }

  schedule(delay = 0): void {
    this.scheduler.schedule(this.recoveryWait(delay))
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      for (;;) {
        // One selection per decision: pruning closed windows may leave no work at all.
        const ordered = this.scheduler.ordered()
        let next = ordered[0]
        if (!next) {
          return
        }
        if (this.hostedJobs.completeFromCache(next)) {
          continue
        }
        const waitMs = next.dueAt - Date.now()
        if (waitMs > 0) {
          this.schedule(waitMs)
          return
        }

        let delay = this.pacing.entryDelay(next)
        if (delay > 0) {
          const runnable = ordered.find(
            (entry) => entry.dueAt <= Date.now() && this.pacing.entryDelay(entry) === 0
          )
          if (runnable && runnable.key !== next.key) {
            next = runnable
            delay = 0
          } else {
            this.scheduler.notePacingDelay(next)
            this.schedule(Math.min(delay, this.scheduler.nextQueuedWakeDelay(next.key) ?? delay))
            return
          }
        }

        if (next.recovery) {
          await this.recovery?.run(next)
          if (this.queue.get(next.key) === next && next.dueAt <= Date.now()) {
            this.queue.delete(next.key)
          }
          continue
        }
        this.queue.delete(next.key)
        if (this.hostedJobs.completeFromCache(next)) {
          continue
        }
        const aliases = Array.from(next.aliases.values())
        const skippedReason = validateCandidate(next.candidate)
        if (skippedReason) {
          next.hosted?.finish(null)
          this.events.record('skipped', next.reason, skippedReason)
          this.events.broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason })
          continue
        }
        if (
          !(this.registrationCheck?.(next.candidate) ?? true) ||
          (next.reason === 'visible' && !this.visibility.has(next.key)) ||
          // E9: gh/Git in a stopped distro's repo boots it; a queued refresh keeps the current status.
          (isBackground(next.reason) &&
            wslDistroForPath(next.candidate.repoPath, next.candidate.localGitOptions?.wslDistro) &&
            (await blockedWslDistroForPath(
              next.candidate.repoPath,
              next.candidate.localGitOptions?.wslDistro
            )))
        ) {
          next.hosted?.finish(null)
          this.events.broadcast({
            aliases,
            reason: next.reason,
            status: 'skipped',
            skippedReason: 'fresh'
          })
          this.watchJobs.skipped(next)
          continue
        }
        if (
          !next.hosted &&
          !next.watch &&
          !next.bypassBackgroundBudget &&
          (next.reason === 'visible' || next.reason === 'swr')
        ) {
          const candidate = next.candidate
          const fresh = freshQueuedPROutcome(candidate, next.reason, next.foreground)
          if (fresh) {
            this.events.broadcast({ aliases, reason: next.reason, outcome: fresh })
            this.scheduler.scheduleVisibleFollowUp(
              next.key,
              candidate,
              fresh,
              next.priority,
              aliases,
              next.windowId
            )
            continue
          }
        }
        const requestSequence = this.events.nextSequence()
        const requestStartedAt = Date.now()
        this.queue.noteRequestStarted(next.key, requestSequence)
        if (!next.hosted) {
          this.events.broadcast(
            { aliases, reason: next.reason, status: 'in-flight', requestStartedAt },
            requestSequence
          )
        }

        const joinedRead = next.hosted?.prepared.pending()
        if (isBackground(next.reason) && !joinedRead) {
          const checkRateLimit = () => prRefreshRateLimitPausedUntil(next.candidate, true)
          const pausedUntil = await (next.hosted
            ? next.hosted.prepared.withExecution(checkRateLimit)
            : checkRateLimit())
          if (!this.queue.ownsRequest(next.key, requestSequence)) {
            next.hosted?.finish(null)
            continue
          }
          // A job retired or replaced while quota was checked never starts.
          if (
            !this.admission.admitAfterQuota(
              next,
              pausedUntil,
              this.hostedJobs.completeFromCache(next),
              requestSequence
            )
          ) {
            continue
          }
          // A watch's earlier-head read starts next; every other read is charged at its start.
          if (next.watch) {
            this.admission.chargeBudget(next)
          }
        }

        if (await this.watchJobs.readHead(next)) {
          continue
        }
        const outcome = await readQueuedPRRefresh(
          {
            queue: this.queue,
            retry: this.retry,
            visibility: this.visibility,
            events: this.events,
            scheduler: this.scheduler,
            admission: this.admission,
            requests: this.requests
          },
          next,
          aliases,
          requestSequence,
          requestStartedAt,
          joinedRead
        )
        if (!outcome || !this.queue.ownsRequest(next.key, requestSequence)) {
          continue
        }
        const plannedRetryAt = this.retry.errorFollowUpAt(
          next.key,
          this.visibility.candidate(next.key, next.candidate),
          outcome,
          !next.hosted && this.visibility.has(next.key)
        )
        const broadcastOutcome =
          plannedRetryAt === undefined
            ? outcome
            : this.retry.withErrorSchedule(outcome, plannedRetryAt)
        this.retry.noteManualGate(next.key, broadcastOutcome)
        if (next.hosted) {
          if (outcome.kind !== 'upstream-error') {
            this.retry.reset(next.key)
          }
          next.hosted.finish(broadcastOutcome)
          continue
        }
        this.events.broadcast(
          { aliases, reason: next.reason, outcome: broadcastOutcome, requestStartedAt },
          requestSequence
        )
        if (next.watch) {
          this.watchJobs.afterOutcome(next, outcome)
          continue
        }
        this.scheduler.scheduleVisibleFollowUp(
          next.key,
          next.candidate,
          outcome,
          next.priority,
          aliases,
          next.windowId,
          { plannedRetryAt }
        )
      }
    } finally {
      this.draining = false
    }
  }
}
