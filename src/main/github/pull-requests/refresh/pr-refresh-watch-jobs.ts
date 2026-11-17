import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'

export type PRWatchJob = NonNullable<PRRefreshQueueEntry['watch']>

export type PRWatchJobHooks = {
  /** False once the watch ends, so its job is not read again. */
  isWatched: (job: PRWatchJob) => boolean
  /** Reads one earlier head's checks; resolves the next due time, or null when that head is done. */
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

export function prWatchQueueKey(job: PRWatchJob): string {
  return job.headSha ? `sha-checks::${job.prKey}::${job.headSha}` : `watch::${job.prKey}`
}

/** A complete read with nothing left running, or a complete read with no checks at all. A failed
 *  check beside a running one is not done, whatever the sidebar's failure-first summary says. */
export function prChecksDone(pr: PRInfo): boolean {
  return (
    pr.checksFinal === true || (pr.checksReadComplete === true && pr.checksSummary?.total === 0)
  )
}

/** A watch's next read: the background cadence, or none once the PR has settled. */
export function prWatchNextDueAt(outcome: PRRefreshOutcome): number | null {
  if (outcome.kind === 'upstream-error') {
    return null
  }
  const pr = outcome.kind === 'found' ? outcome.pr : null
  const interval = reviewRefreshIntervalMs({
    state: pr?.state ?? null,
    checksStatus: pr && !prChecksDone(pr) ? 'pending' : (pr?.checksStatus ?? null),
    hasReview: pr !== null,
    selected: false
  })
  return interval === null ? null : outcome.fetchedAt + interval
}

/** A new watch keeps the earliest due time; a read from elsewhere only defers a queued one. */
export function schedulePRWatchEntry(
  queue: PRRefreshQueue,
  job: PRWatchJob,
  candidate: GitHubPRRefreshCandidate,
  dueAt: number,
  defer: boolean
): void {
  const key = prWatchQueueKey(job)
  const existing = queue.get(key)
  if (existing) {
    existing.candidate = candidate
    existing.dueAt = defer ? Math.max(existing.dueAt, dueAt) : Math.min(existing.dueAt, dueAt)
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
    watch: job
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
    if (entry.reason !== 'visible' || entry.candidate.isSelected !== true) {
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

  /** Runs an earlier head's job; false for any other entry, which the drain reads as usual. */
  async readHead(entry: PRRefreshQueueEntry): Promise<boolean> {
    const headSha = entry.watch?.headSha
    if (!entry.watch || !headSha) {
      return false
    }
    const job = { prKey: entry.watch.prKey, headSha }
    this.followUp(entry, (await this.hooks?.readHeadChecks(job, entry.candidate)) ?? null)
    return true
  }

  afterOutcome(entry: PRRefreshQueueEntry, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'upstream-error') {
      this.followUp(entry, this.retry.nextVisibleErrorRetryAt(entry.key, entry.candidate))
      return
    }
    this.retry.reset(entry.key)
    this.followUp(entry, prWatchNextDueAt(outcome))
  }

  private followUp(entry: PRRefreshQueueEntry, dueAt: number | null): void {
    const job = entry.watch
    if (!job || dueAt === null || !(this.hooks?.isWatched(job) ?? false)) {
      return
    }
    schedulePRWatchEntry(this.queue, job, entry.candidate, dueAt, false)
    this.drainer.schedule(Math.max(0, dueAt - Date.now()))
  }
}
