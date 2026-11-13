import { shouldAcceptMergedFallbackPR } from '../../../../shared/github/pull-requests/refresh/pr-branch-fallback-rule'
import {
  settledForegroundAgeMs,
  reviewRefreshIntervalMs,
  scaleReviewRefreshInterval,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { GitHubPRBranchLookupOptions } from '../../client/lookup/pull-request-lookup-data'
import { PR_CHECK_PAGE_LIMIT } from '../../client/check/pr-check-rollup'
import { parsePRKey } from '../../pr-watch/pr-watch-types'
import { quietPRIntervalForCandidate } from '../../client/lookup/pr-quiet-policy-evidence'
import type { readTimedPROutcome } from '../../client/lookup/pr-last-outcome'

export const MANUAL_MERGEABILITY_PENDING_REFRESH_MS = 2_500
export const POST_PUSH_DELAY_MS = 2_500

type PRBranchLookupCandidate = Pick<
  GitHubPRRefreshCandidate,
  'localGitOptions' | 'linkedPRNumber' | 'fallbackPRNumber' | 'fallbackPRSource' | 'currentHeadOid'
>

export function hostedReviewOptionArgs(
  candidate: PRBranchLookupCandidate,
  reason: GitHubPRRefreshReason = 'visible',
  requestOptions: { userRefresh?: boolean; watchPRKey?: string } = {}
): [] | [GitHubPRBranchLookupOptions] {
  const options: GitHubPRBranchLookupOptions =
    requestOptions.userRefresh === true ? { userRefresh: true } : {}
  if (bypassesFreshnessDelay(reason)) {
    options.resetQuietBackoff = true
  }
  options.localGitExecOptions = {
    ...(candidate.localGitOptions?.wslDistro
      ? { wslDistro: candidate.localGitOptions.wslDistro }
      : {}),
    admissionTier: admissionTierForRefreshReason(reason)
  }
  if (shouldAcceptMergedFallbackPR(candidate)) {
    options.acceptMergedFallbackPR = true
  }
  if (reason === 'watch') {
    options.includeDerivedData = false
    options.checkPageLimit = PR_CHECK_PAGE_LIMIT
    // A watch knows its PR's repository; probing another remote by number could read another PR.
    const pr = requestOptions.watchPRKey ? parsePRKey(requestOptions.watchPRKey) : null
    if (pr) {
      options.exactRepository = {
        owner: pr.owner,
        repo: pr.repo,
        ...(pr.host === 'github.com' ? {} : { host: pr.host })
      }
    }
  }
  if (typeof candidate.currentHeadOid === 'string' && candidate.currentHeadOid.trim().length > 0) {
    options.currentHeadOid = candidate.currentHeadOid.trim()
  }
  return Object.keys(options).length > 0 ? [options] : []
}

export function admissionTierForRefreshReason(
  reason: GitHubPRRefreshReason
): 'interactive' | 'background' {
  return reason === 'manual' ? 'interactive' : 'background'
}

export function refreshKey(candidate: GitHubPRRefreshCandidate): string {
  const connectionScope = candidate.connectionId ?? 'local'
  const runtimeScope = candidate.connectionId
    ? 'remote'
    : `runtime:${candidate.localGitOptions?.wslDistro ? `wsl:${candidate.localGitOptions.wslDistro}` : 'host'}`
  if (typeof candidate.linkedPRNumber === 'number') {
    return `${connectionScope}::${runtimeScope}::${candidate.repoPath}::pr::${candidate.linkedPRNumber}`
  }
  return `${connectionScope}::${runtimeScope}::${candidate.repoPath}::branch::${candidate.branch}`
}

export function validateCandidate(
  candidate: GitHubPRRefreshCandidate
): GitHubPRRefreshSkippedReason | null {
  if (candidate.repoKind !== 'git') {
    return 'not-git'
  }
  if (candidate.isBare) {
    return 'bare'
  }
  if (candidate.isArchived) {
    return 'archived'
  }
  if (candidate.connectionId && candidate.connectionState === 'disconnected') {
    return 'disconnected'
  }
  if (!candidate.branch && typeof candidate.linkedPRNumber !== 'number') {
    return 'fresh'
  }
  return null
}

export function bypassesFreshnessDelay(reason: GitHubPRRefreshReason): boolean {
  return reason === 'manual' || reason === 'active' || reason === 'post-push'
}

export function isBackground(reason: GitHubPRRefreshReason): boolean {
  return reason !== 'manual'
}

export function isBudgetedBackground(reason: GitHubPRRefreshReason): boolean {
  return reason === 'visible' || reason === 'swr' || reason === 'watch'
}

export function shouldBroadcastQueued(reason: GitHubPRRefreshReason, dueAt: number): boolean {
  if (isBudgetedBackground(reason)) {
    return false
  }
  const delay = dueAt - Date.now()
  return delay > 0 && delay <= 5_000
}

export function shouldSkipFresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason
): boolean {
  if (
    bypassesFreshnessDelay(reason) ||
    candidate.cachedFetchedAt == null ||
    hasStaleHead(candidate)
  ) {
    return false
  }
  return Date.now() - candidate.cachedFetchedAt < refreshIntervalForCandidate(candidate)
}

export function freshRetryAt(candidate: GitHubPRRefreshCandidate): number | null {
  return candidate.cachedFetchedAt == null || hasStaleHead(candidate)
    ? null
    : candidate.cachedFetchedAt + refreshIntervalForCandidate(candidate)
}

export function aliasFromCandidate(candidate: GitHubPRRefreshCandidate): GitHubPRRefreshAlias {
  return {
    cacheKey: candidate.cacheKey,
    repoId: candidate.repoId,
    repoPath: candidate.repoPath,
    branch: candidate.branch,
    worktreeId: candidate.worktreeId,
    connectionId: candidate.connectionId ?? null,
    currentHeadOid: candidate.currentHeadOid ?? null,
    linkedPRNumber: candidate.linkedPRNumber ?? null,
    fallbackPRNumber:
      candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    fallbackPRSource: candidate.linkedPRNumber == null ? (candidate.fallbackPRSource ?? null) : null
  }
}

export function visibleCandidateAfterOutcome(
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
): GitHubPRRefreshCandidate {
  if (outcome.kind === 'upstream-error') {
    return candidate
  }
  return {
    ...candidate,
    cachedFetchedAt: outcome.fetchedAt,
    cachedHeadOid: candidate.currentHeadOid ?? null,
    cachedHasPR: outcome.kind === 'found',
    cachedPRState: outcome.kind === 'found' ? outcome.pr.state : null,
    cachedChecksStatus: outcome.kind === 'found' ? outcome.pr.checksStatus : null,
    cachedMergeable: outcome.kind === 'found' ? outcome.pr.mergeable : null,
    cachedMergeStateStatus: outcome.kind === 'found' ? (outcome.pr.mergeStateStatus ?? null) : null
  }
}

const SELECTED_VISIBLE_PRIORITY = 80
const LIST_VISIBLE_PRIORITY = 40

/** The selected workspace's follow-up wins the next list-budget slot; a deselected one rejoins list order. */
export function visibleFollowUpPriority(
  candidate: GitHubPRRefreshCandidate,
  priority: number
): number {
  return candidate.isSelected === true
    ? Math.max(priority, SELECTED_VISIBLE_PRIORITY)
    : Math.min(priority, LIST_VISIBLE_PRIORITY)
}

export function hasStaleHead(candidate: GitHubPRRefreshCandidate): boolean {
  return (
    candidate.currentHeadOid != null &&
    candidate.cachedHeadOid != null &&
    candidate.currentHeadOid !== candidate.cachedHeadOid
  )
}

export function refreshIntervalForCandidate(
  candidate: GitHubPRRefreshCandidate,
  cadence?: PRAutoRefreshCadence
): number {
  if (candidate.cachedFetchedAt != null && !hasStaleHead(candidate)) {
    const quiet = quietPRIntervalForCandidate(candidate)
    if (quiet !== null) {
      return scaleReviewRefreshInterval(quiet, cadence) ?? Number.POSITIVE_INFINITY
    }
  }
  return (
    reviewRefreshIntervalMs(
      {
        state: candidate.cachedPRState,
        checksStatus: candidate.cachedChecksStatus,
        hasReview: candidate.cachedHasPR,
        selected: candidate.isSelected
      },
      cadence
    ) ?? Number.POSITIVE_INFINITY
  )
}

/** An exact completed answer a timed read may still take: its quiet or normal host interval,
 *  scaled by the cadence, has not passed since it was read. A queued row's foreground exposure was
 *  made due by the Default interval, so the answer is judged by that same unscaled interval. */
export function freshTimedPROutcome(
  cached: ReturnType<typeof readTimedPROutcome>,
  entry?: { candidate: GitHubPRRefreshCandidate; foreground?: boolean }
): PRRefreshOutcome | null {
  if (!cached || cached.outcome.kind === 'upstream-error') {
    return null
  }
  const outcome = cached.outcome
  const cadence = entry?.foreground ? 'default' : undefined
  const interval =
    cached.quietIntervalMs !== null
      ? scaleReviewRefreshInterval(cached.quietIntervalMs, cadence)
      : reviewRefreshIntervalMs(
          {
            state: outcome.kind === 'found' ? outcome.pr.state : null,
            checksStatus: outcome.kind === 'found' ? outcome.pr.checksStatus : null,
            hasReview: outcome.kind === 'found',
            selected: entry ? entry.candidate.isSelected === true : true
          },
          cadence
        )
  return interval === null || Date.now() - outcome.fetchedAt < interval ? outcome : null
}

/** How old a candidate's data must be for a foreground exposure to read it now instead of waiting
 *  for its timer, or null when the exposure earns no early read. A row shown again that settled
 *  under Default reads after the settled age (Default's cooldown, a minute otherwise). When the cadence stretches or stops the timer, a row shown
 *  again, or the selected PR on window return, reads once the Default interval has passed: the
 *  cadence slows the timers, never the user's return, and never makes it faster than Default. */
export function foregroundExposureAgeMs(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  priority: number,
  reexposed: boolean
): number | null {
  const defaultInterval = refreshIntervalForCandidate(candidate, 'default')
  if (!Number.isFinite(defaultInterval)) {
    return reexposed ? settledForegroundAgeMs() : null
  }
  const foreground =
    reexposed || (reason === 'visible' && candidate.isSelected === true && priority >= 80)
  return foreground && defaultInterval < refreshIntervalForCandidate(candidate)
    ? defaultInterval
    : null
}

function hasResolvedMergeStateStatus(status: string | null | undefined): boolean {
  return status === 'CLEAN' || status === 'BEHIND' || status === 'BLOCKED'
}

export function isMergeabilityPendingOutcome(outcome: PRRefreshOutcome): boolean {
  return (
    outcome.kind === 'found' &&
    outcome.pr.state === 'open' &&
    outcome.pr.mergeable === 'UNKNOWN' &&
    !hasResolvedMergeStateStatus(outcome.pr.mergeStateStatus)
  )
}

export function sameAliasRequestIdentity(
  left: GitHubPRRefreshAlias,
  right: GitHubPRRefreshAlias
): boolean {
  return (
    left.cacheKey === right.cacheKey &&
    left.repoId === right.repoId &&
    left.repoPath === right.repoPath &&
    left.branch === right.branch &&
    left.worktreeId === right.worktreeId &&
    left.connectionId === right.connectionId &&
    left.executionHostId === right.executionHostId &&
    left.linkedPRNumber === right.linkedPRNumber &&
    left.fallbackPRNumber === right.fallbackPRNumber &&
    left.fallbackPRSource === right.fallbackPRSource &&
    left.currentHeadOid === right.currentHeadOid
  )
}
