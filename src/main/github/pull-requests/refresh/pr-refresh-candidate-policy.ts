import { shouldAcceptMergedFallbackPR } from '../../../../shared/github/pull-requests/refresh/pr-branch-fallback-rule'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
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

export function refreshIntervalForCandidate(candidate: GitHubPRRefreshCandidate): number {
  return (
    reviewRefreshIntervalMs({
      state: candidate.cachedPRState,
      checksStatus: candidate.cachedChecksStatus,
      hasReview: candidate.cachedHasPR,
      selected: candidate.isSelected
    }) ?? Number.POSITIVE_INFINITY
  )
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
