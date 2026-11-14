import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { prChecksDone } from '../../../../shared/github/pull-requests/refresh/pr-quiet-refresh'
export { prChecksDone } from '../../../../shared/github/pull-requests/refresh/pr-quiet-refresh'
import {
  getPRAutoRefreshCadence,
  reviewRefreshIntervalMs,
  scaleReviewRefreshInterval,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import { isSelectedBudgetedPRRefresh } from './pr-refresh-pacing'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'

export type PRWatchJob = NonNullable<PRRefreshQueueEntry['watch']>

export type PRWatchJobHooks = {
  /** False once the watch ends, so its job is not read again. */
  isWatched: (job: PRWatchJob) => boolean
  /** Reads one earlier head's checks; resolves when it read them, or null when that head is done. */
  readHeadChecks: (
    job: Required<PRWatchJob>,
    candidate: GitHubPRRefreshCandidate
  ) => Promise<number | null>
}

/** A watch overdue by one background interval outranks visible reads, so none starves. */
export const PR_WATCH_AGING_MS = 120_000
const PR_WATCH_PRIORITY = 20
// An aged watch takes the next budgeted start above visible reads (40), then yields one back
// (30), so under saturation watches and visible rows alternate and neither starves.
const AGED_PR_WATCH_PRIORITY = 50
const YIELDING_PR_WATCH_PRIORITY = 30
// A watch skipped while its repo's WSL distro is stopped looks again later, without starting it.
const PR_WATCH_SKIPPED_RETRY_MS = 15 * 60_000
const HEAD_CHECKS_INTERVAL_MS = 120_000

/** What a watch's next read is planned from, so a cadence change derives it again from the same
 *  anchor: a read of the PR (when, and the state it showed), an earlier head's read, or the
 *  watch's current failure. A first read or a WSL skip has no plan; its time stands. */
export type PRWatchPlan =
  | { kind: 'read'; at: number; pr: Parameters<typeof reviewRefreshIntervalMs>[0] }
  | { kind: 'head'; at: number }
  | { kind: 'failure' }

export function prWatchQueueKey(job: PRWatchJob): string {
  return job.headSha ? `sha-checks::${job.prKey}::${job.headSha}` : `watch::${job.prKey}`
}

/** The cadence every CI-line watch read follows, current head and earlier heads alike: a chat asked
 *  for this PR's CI result, so "off" slows the watch to Minimal rather than ending it unanswered. */
export function prWatchCadence(
  cadence: PRAutoRefreshCadence = getPRAutoRefreshCadence()
): Exclude<PRAutoRefreshCadence, 'off'> {
  return cadence === 'off' ? 'minimal' : cadence
}

/** The plan a read of the PR gives its watch; none for a failed read. */
export function prWatchReadPlan(
  outcome: PRRefreshOutcome
): Extract<PRWatchPlan, { kind: 'read' }> | null {
  if (outcome.kind === 'upstream-error') {
    return null
  }
  const pr = outcome.kind === 'found' ? outcome.pr : null
  return {
    kind: 'read',
    at: outcome.fetchedAt,
    pr: {
      state: pr?.state ?? null,
      checksStatus: pr && !prChecksDone(pr) ? 'pending' : (pr?.checksStatus ?? null),
      hasReview: pr !== null,
      selected: false
    }
  }
}

/** When a read- or head-planned watch reads next under the current watch cadence, from its anchor;
 *  null once its read showed the PR settled. */
export function prWatchPlanDueAt(plan: Exclude<PRWatchPlan, { kind: 'failure' }>): number | null {
  if (plan.kind === 'head') {
    return (
      plan.at +
      (scaleReviewRefreshInterval(HEAD_CHECKS_INTERVAL_MS, prWatchCadence()) ??
        HEAD_CHECKS_INTERVAL_MS)
    )
  }
  const interval = reviewRefreshIntervalMs(plan.pr, prWatchCadence())
  return interval === null ? null : plan.at + interval
}

/** A watch's next read: the background cadence, or none once the PR has settled. */
export function prWatchNextDueAt(outcome: PRRefreshOutcome): number | null {
  const plan = prWatchReadPlan(outcome)
  return plan && prWatchPlanDueAt(plan)
}

/** A new watch keeps the earliest due time; a read from elsewhere only defers a queued one. The
 *  plan that sets the due time stays with it. */
export function schedulePRWatchEntry(
  queue: PRRefreshQueue,
  job: PRWatchJob,
  candidate: GitHubPRRefreshCandidate,
  dueAt: number,
  defer: boolean,
  plan?: PRWatchPlan
): void {
  const key = prWatchQueueKey(job)
  const existing = queue.get(key)
  if (existing) {
    existing.candidate = candidate
    const next = defer ? Math.max(existing.dueAt, dueAt) : Math.min(existing.dueAt, dueAt)
    if (next !== existing.dueAt) {
      existing.dueAt = next
      existing.watchPlan = plan
    }
    return
  }
  if (defer) {
    return
  }
  queue.set(key, {
    key,
    candidate,
    // Watch reads update no card, so they name no alias the renderer would show as refreshing.
    aliases: new Map(),
    reason: 'watch',
    priority: PR_WATCH_PRIORITY,
    dueAt,
    queuedAt: queue.nextOrder(),
    watch: job,
    watchPlan: plan
  })
}

/** Watch jobs inside the drain: they re-enqueue themselves whether or not any window shows the PR. */
export class PRWatchJobRunner {
  private hooks: PRWatchJobHooks | null = null
  private lastBudgetedStartWasWatch = false

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly retry: PRRefreshRetryState,
    private readonly drainer: { schedule: (delay: number) => void }
  ) {}

  setHooks(hooks: PRWatchJobHooks | null): void {
    this.hooks = hooks
  }

  noteBudgetedStart(entry: PRRefreshQueueEntry): void {
    // Selected list reads have their own reserved turn; preserve the watch/list alternation.
    if (!isSelectedBudgetedPRRefresh(entry)) {
      this.lastBudgetedStartWasWatch = entry.watch !== undefined
    }
  }

  /** Re-ranks watch entries before each pick, so aging needs no change to the queue's order. */
  age(entries: Iterable<PRRefreshQueueEntry>, now: number): void {
    const aged = this.lastBudgetedStartWasWatch
      ? YIELDING_PR_WATCH_PRIORITY
      : AGED_PR_WATCH_PRIORITY
    for (const entry of entries) {
      if (entry.watch) {
        entry.priority = now - entry.dueAt >= PR_WATCH_AGING_MS ? aged : PR_WATCH_PRIORITY
      }
    }
  }

  skipped(entry: PRRefreshQueueEntry): void {
    this.followUp(entry, Date.now() + PR_WATCH_SKIPPED_RETRY_MS)
  }

  /** When a queued watch reads next under the current watch cadence, from the read or failure it
   *  was planned from; undefined when it has no plan, so its time stands. */
  plannedDueAt(entry: PRRefreshQueueEntry): number | null | undefined {
    const plan = entry.watchPlan
    if (!plan) {
      return undefined
    }
    return plan.kind === 'failure'
      ? this.retry.retimedVisibleErrorRetryAt(entry.key, entry.candidate, prWatchCadence())
      : prWatchPlanDueAt(plan)
  }

  /** A cadence change: every queued watch takes the time its plan gives under the new cadence. */
  retime(): void {
    for (const entry of this.queue.values()) {
      const dueAt = entry.watch ? this.plannedDueAt(entry) : undefined
      if (dueAt != null) {
        entry.dueAt = Math.max(dueAt, this.queue.backgroundGateUntil(entry.key))
      }
    }
  }

  /** Runs an earlier head's job; false for any other entry, which the drain reads as usual. */
  async readHead(entry: PRRefreshQueueEntry): Promise<boolean> {
    const headSha = entry.watch?.headSha
    if (!entry.watch || !headSha) {
      return false
    }
    const job = { prKey: entry.watch.prKey, headSha }
    const at = (await this.hooks?.readHeadChecks(job, entry.candidate)) ?? null
    const plan = at === null ? null : ({ kind: 'head', at } as const)
    this.followUp(entry, plan && prWatchPlanDueAt(plan), plan)
    return true
  }

  afterOutcome(entry: PRRefreshQueueEntry, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'upstream-error') {
      // Watches keep retrying under "off" (at Minimal), unlike ordinary visible reads.
      this.followUp(
        entry,
        this.retry.nextVisibleErrorRetryAt(entry.key, entry.candidate, prWatchCadence()),
        { kind: 'failure' }
      )
      return
    }
    this.retry.reset(entry.key)
    const plan = prWatchReadPlan(outcome)
    this.followUp(entry, plan && prWatchPlanDueAt(plan), plan)
  }

  private followUp(
    entry: PRRefreshQueueEntry,
    dueAt: number | null,
    plan: PRWatchPlan | null = null
  ): void {
    const job = entry.watch
    if (!job || dueAt === null || !(this.hooks?.isWatched(job) ?? false)) {
      return
    }
    schedulePRWatchEntry(this.queue, job, entry.candidate, dueAt, false, plan ?? undefined)
    this.drainer.schedule(Math.max(0, dueAt - Date.now()))
  }
}
