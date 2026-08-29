import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { getPRForBranchOutcome } from './client'
import {
  freshRetryAt,
  hostedReviewOptionArgs,
  isBackground,
  isMergeabilityPendingOutcome,
  validateCandidate,
  visibleCandidateAfterOutcome
} from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'

export class PRRefreshQueueDrainer {
  private draining = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher
  ) {}

  schedule(delay = 0): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
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
    if (!this.visibility.has(key)) {
      this.retry.reset(key)
      return
    }
    if (outcome.kind === 'upstream-error') {
      const retryAt = options?.plannedRetryAt ?? this.retry.nextVisibleErrorRetryAt(key)
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
    const followUpCandidate = visibleCandidateAfterOutcome(candidate, outcome)
    const regularDueAt = freshRetryAt(followUpCandidate) ?? Date.now()
    const pendingDueAt =
      options?.pendingMergeabilityDelayMs !== undefined && isMergeabilityPendingOutcome(outcome)
        ? outcome.fetchedAt + options.pendingMergeabilityDelayMs
        : null
    const dueAt = pendingDueAt === null ? regularDueAt : Math.min(regularDueAt, pendingDueAt)
    this.queue.setVisibleFollowUp({
      key,
      candidate: followUpCandidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt,
      queuedAt: this.queue.nextOrder(),
      bypassBackgroundBudget: pendingDueAt !== null,
      windowId
    })
    this.schedule(Math.max(0, dueAt - Date.now()))
  }

  private ordered(): PRRefreshQueueEntry[] {
    return this.queue.ordered((a, b) => this.pacing.activeOrder(a, b))
  }

  private nextQueuedWakeDelay(excludedKey: string): number | null {
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

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      while (this.queue.size > 0) {
        let next = this.ordered()[0]
        const waitMs = next.dueAt - Date.now()
        if (waitMs > 0) {
          this.schedule(waitMs)
          return
        }

        let delay = this.pacing.entryDelay(next)
        if (delay > 0) {
          const runnable = this.ordered().find(
            (entry) => entry.dueAt <= Date.now() && this.pacing.entryDelay(entry) === 0
          )
          if (runnable && runnable.key !== next.key) {
            next = runnable
            delay = 0
          } else {
            this.notePacingDelay(next)
            this.schedule(Math.min(delay, this.nextQueuedWakeDelay(next.key) ?? delay))
            return
          }
        }

        this.queue.delete(next.key)
        const aliases = Array.from(next.aliases.values())
        const skippedReason = validateCandidate(next.candidate)
        if (skippedReason) {
          this.events.record('skipped', next.reason, skippedReason)
          this.events.broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason })
          continue
        }
        if (next.reason === 'visible' && !this.visibility.has(next.key)) {
          this.retry.reset(next.key)
          this.events.broadcast({
            aliases,
            reason: next.reason,
            status: 'skipped',
            skippedReason: 'fresh'
          })
          continue
        }
        const requestSequence = this.events.nextSequence()
        const requestStartedAt = Date.now()
        this.events.broadcast(
          { aliases, reason: next.reason, status: 'in-flight', requestStartedAt },
          requestSequence
        )

        if (isBackground(next.reason)) {
          const pausedUntil = await prRefreshRateLimitPausedUntil(next.candidate, true)
          if (pausedUntil !== null) {
            this.queue.set(next.key, { ...next, dueAt: pausedUntil })
            this.events.broadcast({
              aliases,
              reason: next.reason,
              status: 'paused',
              pausedUntil,
              skippedReason: 'rate-limit'
            })
            this.schedule(Math.max(1_000, pausedUntil - Date.now()))
            continue
          }
          if (
            next.bypassBackgroundBudget !== true &&
            (next.reason === 'visible' || next.reason === 'swr')
          ) {
            this.pacing.noteBackgroundStart()
          }
          if (next.reason === 'active') {
            this.pacing.noteActiveStart(next)
          }
        }

        const outcome = await getPRForBranchOutcome(
          next.candidate.repoPath,
          next.candidate.branch,
          next.candidate.linkedPRNumber ?? null,
          next.candidate.connectionId ?? null,
          next.candidate.linkedPRNumber == null ? (next.candidate.fallbackPRNumber ?? null) : null,
          ...hostedReviewOptionArgs(next.candidate)
        )
        let plannedRetryAt: number | undefined
        let broadcastOutcome = outcome
        if (outcome.kind === 'upstream-error' && this.visibility.has(next.key)) {
          plannedRetryAt = this.retry.nextVisibleErrorRetryAt(next.key)
          broadcastOutcome = this.retry.withErrorSchedule(outcome, plannedRetryAt)
        }
        this.events.observe(next.candidate, outcome)
        this.retry.noteManualGate(next.key, broadcastOutcome)
        this.events.broadcast(
          { aliases, reason: next.reason, outcome: broadcastOutcome, requestStartedAt },
          requestSequence
        )
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

  private notePacingDelay(entry: PRRefreshQueueEntry): void {
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
      (entry.reason === 'visible' || entry.reason === 'swr') &&
      this.pacing.nextBudgetDelay() > 0
    ) {
      this.events.record('background-pause', entry.reason)
    }
  }
}
