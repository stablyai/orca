import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { preparePRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import {
  aliasFromCandidate,
  refreshKey,
  validateCandidate,
  isBackground,
  hostedReviewOptionArgs,
  MANUAL_MERGEABILITY_PENDING_REFRESH_MS
} from './pr-refresh-candidate-policy'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshQueueDrainer } from './pr-refresh-queue-drainer'

type ImmediateRefreshOwners = {
  queue: PRRefreshQueue
  retry: PRRefreshRetryState
  visibility: PRRefreshVisibility
  events: PRRefreshEventPublisher
  drainer: PRRefreshQueueDrainer
}
export async function runImmediatePRRefresh(
  { queue, retry, visibility, events, drainer }: ImmediateRefreshOwners,
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason = 'manual',
  options: { userRefresh?: boolean } = {}
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
  // E9: renderer fallbacks reach here with automatic reasons; only a manual refresh may start a stopped distro.
  if (
    isBackground(reason) &&
    wslDistroForPath(candidate.repoPath, candidate.localGitOptions?.wslDistro) &&
    (await blockedWslDistroForPath(candidate.repoPath, candidate.localGitOptions?.wslDistro))
  ) {
    events.broadcast({ aliases: [alias], reason, status: 'skipped', skippedReason: 'fresh' })
    // Local callers keep their cached PR on an upstream error; nothing is recorded or retried here.
    return {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'WSL distro is not running',
      fetchedAt: Date.now()
    }
  }

  const primaryGateUntil = await prRefreshRateLimitPausedUntil(candidate, false)
  const gateUntil = Math.max(primaryGateUntil ?? 0, retry.manualGateUntil(key))
  if (gateUntil > Date.now()) {
    queue.protectBackgroundUntil(key, gateUntil)
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
  queue.noteRequestStarted(key, requestSequence)
  events.broadcast({ aliases, reason, status: 'in-flight', requestStartedAt }, requestSequence)
  const prepared = await preparePRBranchRead(
    candidate.repoPath,
    candidate.branch,
    candidate.linkedPRNumber ?? null,
    candidate.connectionId ?? null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    ...hostedReviewOptionArgs(candidate, reason, options)
  )
  try {
    const outcome = await prepared.read((outcome, producer) => {
      if (!prepared.isCurrent()) {
        return outcome
      }
      const settled = retry.settleProducerError(
        outcome,
        key,
        visibility.candidate(key, candidate),
        prepared,
        queue,
        producer,
        visibility.has(key)
      )
      events.observe(candidate, settled, aliases)
      return settled
    })
    if (!queue.ownsRequest(key, requestSequence)) {
      events.broadcast({ aliases, reason, outcome, requestStartedAt }, requestSequence)
      return outcome
    }
    const plannedRetryAt = visibility.has(key)
      ? retry.errorFollowUpAt(key, visibility.candidate(key, candidate), outcome, true)
      : undefined
    const broadcastOutcome =
      plannedRetryAt === undefined ? outcome : retry.withErrorSchedule(outcome, plannedRetryAt)
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
  } finally {
    prepared.release()
  }
}
