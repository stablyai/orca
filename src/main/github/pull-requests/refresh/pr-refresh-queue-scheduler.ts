import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  aliasFromCandidate,
  freshRetryAt,
  isBudgetedBackground,
  isMergeabilityPendingOutcome,
  sameAliasRequestIdentity,
  visibleCandidateAfterOutcome,
  visibleFollowUpPriority
} from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import { outsideWslUserAct } from '../../../wsl/discovery/wsl-user-act-scope'

export class PRRefreshQueueScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher,
    private readonly watchJobs: PRWatchJobRunner,
    private readonly runDrain: () => Promise<void>
  ) {}

  schedule(delay = 0): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = setTimeout(() => {
      this.timer = null
      // The drain serves every queued repo; a scheduling call inside a WSL user act must not lend it that act.
      void outsideWslUserAct(() => this.runDrain())
    }, delay)
  }

  scheduleVisibleFollowUp(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    outcome: PRRefreshOutcome,
    priority: number,
    aliases: GitHubPRRefreshAlias[],
    windowId?: number,
    options?: { pendingMergeabilityDelayMs?: number; plannedRetryAt?: number }
  ): void {
    if (outcome.kind === 'upstream-error') {
      const retryCandidate = this.visibility.candidate(key, candidate)
      const retryAt = Math.max(
        options?.plannedRetryAt ?? this.retry.nextVisibleErrorRetryAt(key, retryCandidate),
        this.retry.manualGateUntil(key)
      )
      this.queue.protectBackgroundUntil(
        key,
        Math.max(
          this.retry.errorGateAt(key, retryCandidate, retryAt),
          this.retry.manualGateUntil(key)
        )
      )
      // Auto-refresh off: no timed retry; the next selection, push or manual refresh reads again.
      if (Number.isFinite(retryAt)) {
        this.scheduleErrorRetry(key, candidate, retryAt, priority, aliases, windowId)
      }
      return
    }
    this.retry.reset(key)
    const refreshed = visibleCandidateAfterOutcome(candidate, outcome)
    this.visibility.update(refreshed)
    if (!this.visibility.has(key)) {
      return
    }
    const followUpCandidate = this.visibility.candidate(key, refreshed)
    const regularDueAt = freshRetryAt(followUpCandidate) ?? Date.now()
    const pendingDueAt =
      options?.pendingMergeabilityDelayMs !== undefined && isMergeabilityPendingOutcome(outcome)
        ? outcome.fetchedAt + options.pendingMergeabilityDelayMs
        : null
    const dueAt = pendingDueAt === null ? regularDueAt : Math.min(regularDueAt, pendingDueAt)
    if (!Number.isFinite(dueAt)) {
      const pending = this.queue.get(key)
      if (
        pending?.reason === 'visible' &&
        sameAliasRequestIdentity(
          aliasFromCandidate(pending.candidate),
          aliasFromCandidate(followUpCandidate)
        )
      ) {
        this.queue.delete(key)
      }
      return
    }
    this.queue.setVisibleFollowUp({
      key,
      candidate: followUpCandidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority: visibleFollowUpPriority(followUpCandidate, priority),
      dueAt,
      queuedAt: this.queue.nextOrder(),
      bypassBackgroundBudget: pendingDueAt !== null,
      followUp: true,
      windowId
    })
    this.schedule(Math.max(0, dueAt - Date.now()))
  }

  /** Queues the automatic retry a failure earned; it stays an error retry until it runs, is
   *  replaced or a cadence change retires it. */
  scheduleErrorRetry(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    retryAt: number,
    priority: number,
    aliases: GitHubPRRefreshAlias[],
    windowId?: number
  ): void {
    if (!this.visibility.has(key)) {
      return
    }
    this.queue.setVisibleFollowUp({
      key,
      candidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt: retryAt,
      queuedAt: this.queue.nextOrder(),
      errorRetry: true,
      windowId
    })
    this.schedule(retryAt - Date.now())
  }

  ordered(): PRRefreshQueueEntry[] {
    this.watchJobs.age(this.queue.values(), Date.now())
    return this.queue.ordered((a, b) => this.pacing.order(a, b))
  }

  nextQueuedWakeDelay(excludedKey: string): number | null {
    const now = Date.now()
    let nextDelay = Number.POSITIVE_INFINITY
    for (const entry of this.queue.values()) {
      if (entry.key === excludedKey) {
        continue
      }
      const delay = entry.dueAt > now ? entry.dueAt - now : this.pacing.entryDelay(entry)
      nextDelay = Math.min(nextDelay, delay)
    }
    return Number.isFinite(nextDelay) ? Math.max(0, nextDelay) : null
  }

  notePacingDelay(entry: PRRefreshQueueEntry): void {
    if (this.pacing.isActiveBurstDelayed(entry) && !entry.activeDelayNotified) {
      entry.activeDelayNotified = true
      this.events.broadcast({
        aliases: Array.from(entry.aliases.values()),
        reason: entry.reason,
        status: 'queued'
      })
    }
    if (
      entry.bypassBackgroundBudget !== true &&
      isBudgetedBackground(entry.reason) &&
      this.pacing.nextBudgetDelay() > 0
    ) {
      this.events.record('background-pause', entry.reason)
    }
  }
}
