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
import type {
  PreparedPRBranchRead,
  PRReadSettlement
} from '../../client/lookup/pr-for-branch-outcome'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import { outsideWslUserAct } from '../../../wsl/discovery/wsl-user-act-scope'

export class PRRefreshQueueScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDueAt = Infinity

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
    const dueAt = performance.now() + Math.max(0, delay)
    if (this.timer !== null && this.timerDueAt <= dueAt) {
      return
    }
    clearTimeout(this.timer ?? undefined)
    this.timerDueAt = dueAt
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerDueAt = Infinity
      // The drain serves every queued repo; a scheduling call inside a WSL user act must not lend it that act.
      void outsideWslUserAct(() => this.runDrain())
    }, delay)
  }

  settleRead(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    aliases: GitHubPRRefreshAlias[],
    prepared: PreparedPRBranchRead,
    requestSequence: number,
    hosted = false
  ): PRReadSettlement {
    return (outcome, producer) => {
      if (!prepared.isCurrent()) {
        return outcome
      }
      const settled =
        producer.retained &&
        this.queue.ownsRequest(key, requestSequence) &&
        outcome.kind === 'upstream-error' &&
        (hosted || this.visibility.has(key))
          ? this.retry.settleProducerError(
              outcome,
              key,
              hosted
                ? { ...candidate, isSelected: false }
                : this.visibility.candidate(key, candidate),
              prepared,
              this.queue
            )
          : outcome
      this.events.observe(candidate, settled, aliases)
      return settled
    }
  }

  completeWithoutOutcome(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    aliases: GitHubPRRefreshAlias[],
    priority: number,
    windowId?: number,
    foreground = false
  ): void {
    if (!this.visibility.has(key) || this.queue.get(key)) {
      return
    }
    const current = this.visibility.candidate(key, candidate)
    const dueAt = Math.max(
      freshRetryAt(current, foreground) ?? Date.now(),
      this.queue.backgroundGateUntil(key),
      this.retry.manualGateUntil(key)
    )
    if (!Number.isFinite(dueAt)) {
      return
    }
    this.queue.setVisibleFollowUp({
      key,
      candidate: current,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority: visibleFollowUpPriority(current, priority),
      dueAt,
      queuedAt: this.queue.nextOrder(),
      followUp: !foreground,
      foreground,
      windowId
    })
    this.schedule(Math.max(0, dueAt - Date.now()))
  }

  finishWithoutOutcome(
    next: PRRefreshQueueEntry,
    aliases: GitHubPRRefreshAlias[],
    requestSequence: number
  ): void {
    next.hosted?.finish(null)
    if (!next.hosted && this.queue.ownsRequest(next.key, requestSequence)) {
      this.events.broadcast(
        { aliases, reason: next.reason, status: 'skipped', skippedReason: 'fresh' },
        requestSequence
      )
      if (next.watch) {
        this.watchJobs.skipped(next)
      } else {
        this.completeWithoutOutcome(
          next.key,
          next.candidate,
          aliases,
          next.priority,
          next.windowId,
          next.foreground
        )
      }
    }
  }

  consumeGatedError(
    entry: PRRefreshQueueEntry,
    prepared: PreparedPRBranchRead,
    requestSequence: number,
    requestStartedAt: number
  ): boolean {
    if (
      entry.hosted ||
      entry.watch ||
      entry.bypassBackgroundBudget ||
      (entry.reason !== 'visible' && entry.reason !== 'swr') ||
      !prepared.isCurrent()
    ) {
      return false
    }
    const outcome = prepared.cached()?.outcome
    if (outcome?.kind !== 'upstream-error') {
      return false
    }
    const retryAt = Math.max(outcome.nextAutoRetryAt ?? 0, outcome.retryDisabledUntil ?? 0)
    if (retryAt <= Date.now()) {
      return false
    }
    const aliases = Array.from(entry.aliases.values())
    this.retry.noteManualGate(entry.key, outcome)
    this.events.broadcast(
      { aliases, reason: entry.reason, outcome, requestStartedAt },
      requestSequence
    )
    this.scheduleVisibleFollowUp(
      entry.key,
      entry.candidate,
      outcome,
      entry.priority,
      aliases,
      entry.windowId,
      { plannedRetryAt: retryAt }
    )
    return true
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
      const retryAt = Math.max(
        options?.plannedRetryAt ??
          this.retry.nextVisibleErrorRetryAt(key, this.visibility.candidate(key, candidate)),
        this.retry.manualGateUntil(key)
      )
      this.queue.protectBackgroundUntil(key, retryAt)
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
        windowId
      })
      this.schedule(retryAt - Date.now())
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
