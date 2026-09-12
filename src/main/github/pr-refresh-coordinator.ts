import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { getPRForBranchOutcome } from './client'
import {
  aliasFromCandidate,
  hostedReviewOptionArgs,
  MANUAL_MERGEABILITY_PENDING_REFRESH_MS,
  refreshKey,
  shouldBroadcastQueued,
  validateCandidate
} from './pr-refresh-candidate-policy'
import {
  PRRefreshEventPublisher,
  type PRRefreshOutcomeObserver
} from './pr-refresh-event-publisher'
import { PRRefreshPacing } from './pr-refresh-pacing'
import { PRRefreshQueue } from './pr-refresh-queue'
import { PRRefreshQueueDrainer } from './pr-refresh-queue-drainer'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshVisibility } from './pr-refresh-visibility'

const retry = new PRRefreshRetryState()
const queue = new PRRefreshQueue((key) => retry.reset(key))
const pacing = new PRRefreshPacing()
const visibility = new PRRefreshVisibility()
const events = new PRRefreshEventPublisher()
const drainer = new PRRefreshQueueDrainer(queue, pacing, visibility, retry, events)

export function setPRRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver | null): void {
  events.setOutcomeObserver(observer)
}

function removeInvisibleVisibleRefreshes(): void {
  const removed = queue.removeInvisibleVisibleEntries((key) => visibility.has(key))
  for (const entry of removed) {
    events.broadcast({
      aliases: Array.from(entry.aliases.values()),
      reason: 'visible',
      status: 'skipped',
      skippedReason: 'fresh'
    })
  }
}

export function clearVisiblePRRefreshWindow(windowId: number): void {
  const hadVisibleRefreshes = visibility.clearWindow(windowId)
  pacing.clearActiveBurstWindow(windowId)
  if (hadVisibleRefreshes) {
    removeInvisibleVisibleRefreshes()
  }
}

export function pruneWorktreePRRefreshAliases(worktreeId: string): void {
  queue.pruneWorktreeAliases(worktreeId)
}

export function enqueuePRRefresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  priority = 0,
  windowId?: number
): void {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    queue.removeInvalidAlias(key, alias)
    events.record('skipped', reason, skippedReason)
    events.broadcast({ aliases: [alias], reason, status: 'skipped', skippedReason })
    return
  }

  const enqueued = queue.enqueue(candidate, reason, priority, windowId)
  events.record(enqueued.coalesced ? 'coalesced' : 'enqueued', reason)
  if (shouldBroadcastQueued(reason, enqueued.dueAt)) {
    events.broadcast({ aliases: [enqueued.alias], reason, status: 'queued' })
  }
  drainer.schedule()
}

export function reportVisiblePRRefreshCandidates(
  candidates: GitHubPRRefreshCandidate[],
  generation: number,
  windowId: number
): void {
  if (!visibility.report(candidates, generation, windowId)) {
    return
  }
  removeInvisibleVisibleRefreshes()
  for (const candidate of candidates) {
    enqueuePRRefresh(candidate, 'visible', 40, windowId)
  }
}

export function _getVisiblePRRefreshWindowCountForTests(): number {
  return visibility.windowCount
}

export function _getPRRefreshErrorBackoffCountForTests(): number {
  return retry.errorBackoffCount
}

export function _getPRRefreshQueueSizeForTests(): number {
  return queue.size
}

export function _getPRRefreshAliasCountForTests(key: string): number {
  return queue.aliasCount(key)
}

export async function refreshPRNow(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason = 'manual'
): Promise<PRRefreshOutcome> {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const existing = queue.get(key)
  const aliasMap = new Map(existing ? existing.aliases : [])
  aliasMap.set(alias.cacheKey, alias)
  const aliases = Array.from(aliasMap.values())
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    queue.removeInvalidAlias(key, alias)
    const outcome: PRRefreshOutcome = {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: `Cannot refresh PR for this worktree: ${skippedReason}`,
      fetchedAt: Date.now()
    }
    events.broadcast({ aliases: [alias], reason, status: 'skipped', skippedReason })
    return outcome
  }

  const primaryGateUntil = await prRefreshRateLimitPausedUntil(candidate, false)
  const gateUntil = Math.max(primaryGateUntil ?? 0, retry.manualGateUntil(key))
  if (gateUntil > Date.now()) {
    queue.set(key, {
      key,
      candidate,
      aliases: aliasMap,
      reason,
      priority: 40,
      dueAt: gateUntil,
      queuedAt: queue.nextOrder()
    })
    events.broadcast({
      aliases,
      reason,
      status: 'paused',
      pausedUntil: gateUntil,
      skippedReason: 'rate-limit'
    })
    drainer.schedule(Math.max(1_000, gateUntil - Date.now()))
    return {
      kind: 'upstream-error',
      errorType: 'rate_limited',
      message: 'GitHub is temporarily limiting requests. Try again after the limit resets.',
      fetchedAt: Date.now(),
      nextAutoRetryAt: gateUntil,
      retryDisabledUntil: gateUntil
    }
  }

  queue.delete(key)
  const requestSequence = events.nextSequence()
  const requestStartedAt = Date.now()
  events.broadcast({ aliases, reason, status: 'in-flight', requestStartedAt }, requestSequence)
  const outcome = await getPRForBranchOutcome(
    candidate.repoPath,
    candidate.branch,
    candidate.linkedPRNumber ?? null,
    candidate.connectionId ?? null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    ...hostedReviewOptionArgs(candidate, reason)
  )
  let plannedRetryAt: number | undefined
  let broadcastOutcome = outcome
  if (outcome.kind === 'upstream-error' && visibility.has(key)) {
    plannedRetryAt = retry.nextVisibleErrorRetryAt(key)
    broadcastOutcome = retry.withErrorSchedule(outcome, plannedRetryAt)
  }
  events.observe(candidate, outcome)
  retry.noteManualGate(key, broadcastOutcome)
  events.broadcast(
    { aliases, reason, outcome: broadcastOutcome, requestStartedAt },
    requestSequence
  )
  drainer.scheduleVisibleFollowUp(key, candidate, outcome, 40, aliases, undefined, {
    plannedRetryAt,
    ...(reason === 'manual'
      ? { pendingMergeabilityDelayMs: MANUAL_MERGEABILITY_PENDING_REFRESH_MS }
      : {})
  })
  return broadcastOutcome
}
