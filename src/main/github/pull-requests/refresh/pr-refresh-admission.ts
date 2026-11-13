import {
  automaticDueAt,
  candidateReadRequest,
  isBudgetedBackground
} from './pr-refresh-candidate-policy'
import { prBranchReadKeys } from '../../client/lookup/pr-read-identity'
import { usesActiveRefreshPacing, type PRRefreshPacing } from './pr-refresh-pacing'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import type { PRWatchJobRunner } from './pr-refresh-watch-jobs'

/**
 * Whether a dequeued read may start, decided from current state at each wait it crosses: after
 * quota, the plan its own reason still has; after its read was prepared, the failure that still
 * owns its request. Work that may not start yet goes back to the queue, merged with what was
 * queued for its key meanwhile.
 */
export class PRRefreshAdmission {
  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher,
    private readonly drainer: {
      readonly watchJobs: PRWatchJobRunner
      schedule: (delay: number) => void
    }
  ) {}

  /** Local automatic or returned row work, held by its row's failure; for `visible` work, its
   *  demand is a window showing the row. Actions, selected bypass reads, host jobs and watches keep
   *  their own rules and lifetimes. */
  private rowWork(entry: PRRefreshQueueEntry): boolean {
    return (
      !entry.hosted &&
      !entry.watch &&
      !entry.bypassBackgroundBudget &&
      (entry.reason === 'visible' || entry.reason === 'swr')
    )
  }

  /** Whether row work captured before a wait still has its request and a row that wants it: its
   *  local request is still this attempt's, and some window still shows the same exact request,
   *  through any of its aliases. A captured candidate never proves demand by itself. Without both,
   *  the attempt ends: nothing starts, is charged, queued again or claimed, and only its own
   *  loading state, while it still owns it, closes. */
  private stillDemanded(
    entry: PRRefreshQueueEntry,
    requestSequence: number,
    exactKey: string
  ): boolean {
    const shownRequest = (shown: GitHubPRRefreshCandidate) =>
      prBranchReadKeys(...candidateReadRequest(shown, 'visible'))[1] === exactKey
    if (
      this.queue.ownsRequest(entry.key, requestSequence) &&
      this.visibility.hasDemand(entry.key, shownRequest)
    ) {
      return true
    }
    this.endAttempt(entry, requestSequence)
    return false
  }

  /** Ends a dequeued attempt that will not start: only its own loading state closes, at its own
   *  sequence and while it still owns the request, so a newer request is never disturbed. */
  private endAttempt(entry: PRRefreshQueueEntry, requestSequence: number): void {
    if (this.queue.ownsRequest(entry.key, requestSequence)) {
      this.events.broadcast(
        {
          aliases: Array.from(entry.aliases.values()),
          reason: entry.reason,
          status: 'skipped',
          skippedReason: 'fresh'
        },
        requestSequence
      )
    }
  }

  private get watchJobs(): PRWatchJobRunner {
    return this.drainer.watchJobs
  }

  private wake(delay: number): void {
    this.drainer.schedule(delay)
  }

  /** Charges a read's start to the list budget and active pacing, once it really starts. */
  chargeBudget(entry: PRRefreshQueueEntry): void {
    if (entry.bypassBackgroundBudget !== true && isBudgetedBackground(entry.reason)) {
      this.pacing.noteBackgroundStart(entry)
      this.watchJobs.noteBudgetedStart(entry)
    }
    if (usesActiveRefreshPacing(entry)) {
      this.pacing.noteActiveStart(entry)
    }
  }

  /** When an automatic attempt still in its own reason (a follow-up or a failure's retry, not a
   *  return, an action or a forced reread) is due under the current cadence, from the failure that
   *  still owns it or else its row's data; null once that no longer gives it. Checked again once it has
   *  waited for quota, before it may start. A watch is due when its own plan says; other work is
   *  due as queued (0). */
  automaticPlan(entry: PRRefreshQueueEntry): number | null {
    if (entry.watch) {
      return this.watchJobs.plannedDueAt(entry) ?? 0
    }
    if (entry.reason !== 'visible' || entry.hosted || entry.watch || entry.bypassBackgroundBudget) {
      return 0
    }
    const candidate = this.visibility.candidate(entry.key, entry.candidate)
    if (entry.errorRetry) {
      const retryAt = this.retry.retimedVisibleErrorRetryAt(entry.key, candidate)
      if (retryAt !== null) {
        return Number.isFinite(retryAt) ? retryAt : null
      }
      // No failure owns it any more: it is the row's ordinary automatic work.
      entry.errorRetry = false
      entry.followUp = true
    }
    return entry.followUp ? automaticDueAt(candidate) : 0
  }

  /** Whether an attempt that waited for quota may start now. Automatic work the cadence no longer
   *  gives, or a retired job, ends; work its current plan or the pause it learned puts later goes
   *  back, merged with what was queued for its key meanwhile. The pause holds either way. */
  admitAfterQuota(
    entry: PRRefreshQueueEntry,
    pausedUntil: number | null,
    retired: boolean,
    requestSequence: number
  ): boolean {
    if (pausedUntil !== null) {
      this.queue.protectBackgroundUntil(entry.key, pausedUntil)
    }
    if (
      this.rowWork(entry) &&
      entry.reason === 'visible' &&
      !this.stillDemanded(
        entry,
        requestSequence,
        prBranchReadKeys(...candidateReadRequest(entry.candidate, 'visible'))[1]
      )
    ) {
      return false
    }
    const planned = retired ? null : this.automaticPlan(entry)
    if (planned === null) {
      return false
    }
    const dueAt = Math.min(Math.max(planned, pausedUntil ?? 0), entry.hosted?.expiresAt ?? Infinity)
    if (pausedUntil === null && dueAt <= Date.now()) {
      return true
    }
    entry.dueAt = dueAt
    this.queue.requeueCaptured(entry)
    if (!entry.hosted && pausedUntil !== null) {
      this.events.broadcast({
        aliases: Array.from(entry.aliases.values()),
        reason: entry.reason,
        status: 'paused',
        pausedUntil,
        skippedReason: 'rate-limit'
      })
    }
    this.wake(Math.max(1_000, dueAt - Date.now()))
    return false
  }

  /** The last check before a local automatic or returned read starts, after quota and after its
   *  read was prepared, with nothing awaited between it and the provider start: while a failure
   *  that still owns the row's request holds it (its plan, or a rate limit the host reported), the
   *  read does not start. Its demand waits for that time, merged with what was queued meanwhile,
   *  and the row shows that failure. Nothing about the failure is recorded again. Actions, selected
   *  bypass reads, host jobs and watches keep their own rules. */
  admitPreparedRead(
    entry: PRRefreshQueueEntry,
    prepared: PreparedPRBranchRead,
    requestSequence: number,
    requestStartedAt: number
  ): boolean {
    if (!this.rowWork(entry)) {
      return true
    }
    // Waits passed since the quota check: the request, its scope and a row showing it must remain.
    if (!prepared.isCurrent()) {
      this.endAttempt(entry, requestSequence)
      return false
    }
    if (entry.reason === 'visible' && !this.stillDemanded(entry, requestSequence, prepared.key)) {
      return false
    }
    const candidate = this.visibility.candidate(entry.key, entry.candidate)
    const exact = prepared.isCurrent() ? prepared.cached()?.outcome : undefined
    const failure = this.retry.currentFailure(entry.key, candidate, exact)
    if (!failure || failure.gateAt <= Date.now()) {
      return true
    }
    entry.dueAt = failure.gateAt
    this.queue.requeueCaptured(entry)
    this.queue.protectBackgroundUntil(entry.key, failure.gateAt)
    const aliases = Array.from(entry.aliases.values())
    this.events.broadcast(
      failure.outcome
        ? { aliases, reason: entry.reason, outcome: failure.outcome, requestStartedAt }
        : { aliases, reason: entry.reason, status: 'skipped', skippedReason: 'fresh' },
      requestSequence
    )
    this.wake(Math.max(0, failure.gateAt - Date.now()))
    return false
  }
}
