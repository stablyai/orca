import { admitPreparedPRRead } from './pr-refresh-read-admission'
import { deliverablePRBranchOutcome } from '../../client/lookup/pr-branch-read-resources'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { preparePRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import {
  hostedReviewOptionArgs,
  freshQueuedPROutcome,
  bypassesFreshnessDelay,
  isBackground,
  isBudgetedBackground,
  validateCandidate
} from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import { type PRRefreshPacing, usesActiveRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue } from './pr-refresh-queue'
import { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import { HostedPRReadJobs } from './hosted-pr-read-jobs'
import { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'

export type PRRefreshRegistrationCheck = (candidate: GitHubPRRefreshCandidate) => boolean

export class PRRefreshQueueDrainer {
  private draining = false
  registrationCheck: PRRefreshRegistrationCheck | null = null
  readonly watchJobs: PRWatchJobRunner
  readonly hostedJobs: HostedPRReadJobs
  readonly scheduler: PRRefreshQueueScheduler
  readonly scheduleVisibleFollowUp: PRRefreshQueueScheduler['scheduleVisibleFollowUp']

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher
  ) {
    this.watchJobs = new PRWatchJobRunner(queue, retry, this)
    this.scheduler = new PRRefreshQueueScheduler(
      queue,
      pacing,
      visibility,
      retry,
      events,
      this.watchJobs,
      () => this.drain()
    )
    this.scheduleVisibleFollowUp = this.scheduler.scheduleVisibleFollowUp.bind(this.scheduler)
    this.hostedJobs = new HostedPRReadJobs(
      queue,
      pacing,
      retry,
      () => this.schedule(),
      (candidate, outcome) => events.observe(candidate, outcome)
    )
  }

  schedule(delay = 0): void {
    this.scheduler.schedule(delay)
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      const { queue, pacing, events, scheduler, watchJobs } = this
      while (this.queue.size > 0) {
        let next = this.scheduler.ordered()[0]
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
          const runnable = this.scheduler
            .ordered()
            .find((entry) => entry.dueAt <= Date.now() && this.pacing.entryDelay(entry) === 0)
          if (runnable && runnable.key !== next.key) {
            next = runnable
            delay = 0
          } else {
            this.scheduler.notePacingDelay(next)
            this.schedule(Math.min(delay, this.scheduler.nextQueuedWakeDelay(next.key) ?? delay))
            return
          }
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
            this.scheduleVisibleFollowUp(
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
        let joinedRead = next.hosted?.prepared.pending()
        if (isBackground(next.reason) && !joinedRead) {
          const checkRateLimit = () => prRefreshRateLimitPausedUntil(next.candidate, true)
          const pausedUntil = await (next.hosted
            ? next.hosted.prepared.withExecution(checkRateLimit)
            : checkRateLimit())
          if (!this.queue.ownsRequest(next.key, requestSequence)) {
            next.hosted?.finish(null)
            continue
          }
          if (pausedUntil !== null) {
            this.queue.protectBackgroundUntil(next.key, pausedUntil)
            const dueAt = Math.min(pausedUntil, next.hosted?.expiresAt ?? Infinity)
            next.dueAt = dueAt
            this.queue.set(next.key, next)
            if (!next.hosted) {
              this.events.broadcast({
                aliases,
                reason: next.reason,
                status: 'paused',
                pausedUntil,
                skippedReason: 'rate-limit'
              })
            }
            this.schedule(Math.max(1_000, dueAt - Date.now()))
            continue
          }
          if (this.hostedJobs.completeFromCache(next)) {
            continue
          }
          if (
            next.watch &&
            next.bypassBackgroundBudget !== true &&
            isBudgetedBackground(next.reason)
          ) {
            this.pacing.noteBackgroundStart(next)
            this.watchJobs.noteBudgetedStart(next)
          }
          if (next.watch && usesActiveRefreshPacing(next)) {
            this.pacing.noteActiveStart(next)
          }
        }
        if (await this.watchJobs.readHead(next)) {
          continue
        }
        if (next.hosted) {
          next.hosted.running = true
        }
        const prepared =
          next.hosted?.prepared ??
          (await preparePRBranchRead(
            next.candidate.repoPath,
            next.candidate.branch,
            next.candidate.linkedPRNumber ?? null,
            next.candidate.connectionId ?? null,
            next.candidate.linkedPRNumber == null
              ? (next.candidate.fallbackPRNumber ?? null)
              : null,
            ...hostedReviewOptionArgs(next.candidate, next.reason, {
              watchPRKey: next.watch?.prKey
            })
          ))
        joinedRead ??= bypassesFreshnessDelay(next.reason) ? undefined : prepared.pending()
        const admitted = admitPreparedPRRead(
          { queue, pacing, events, scheduler, watchJobs },
          next,
          prepared,
          aliases,
          requestSequence,
          requestStartedAt,
          Boolean(joinedRead)
        )
        if (!admitted) {
          continue
        }
        const settle = this.scheduler.settleRead(
          next.key,
          next.candidate,
          aliases,
          prepared,
          requestSequence,
          Boolean(next.hosted)
        )
        const result = await (joinedRead ?? prepared.readResult(settle, Boolean(next.hosted)))
        const outcome = result ? deliverablePRBranchOutcome(prepared, result) : null
        if (!outcome) {
          this.scheduler.finishWithoutOutcome(next, aliases, requestSequence)
          continue
        }
        if (
          next.hosted &&
          (!next.hosted.prepared.isCurrent() || !next.hosted.prepared.accepts(outcome))
        ) {
          next.hosted.finish(null)
          continue
        }
        if (!this.queue.ownsRequest(next.key, requestSequence)) {
          next.hosted?.finish(null)
          this.events.broadcast(
            { aliases, reason: next.reason, outcome, requestStartedAt },
            requestSequence
          )
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
        this.scheduleVisibleFollowUp(
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
