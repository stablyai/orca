import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import type { GitHubPRBranchLookupOptions } from './client'
import { NO_REVIEW_REFRESH_INTERVAL_MS } from '../source-control/hosted-review-refresh-pacing'

export const MANUAL_MERGEABILITY_PENDING_REFRESH_MS = 2_500
export const POST_PUSH_DELAY_MS = 2_500

type PRBranchLookupCandidate = Pick<
  GitHubPRRefreshCandidate,
  'localGitOptions' | 'linkedPRNumber' | 'fallbackPRNumber' | 'fallbackPRSource' | 'currentHeadOid'
>

function shouldAcceptMergedFallbackPR(candidate: PRBranchLookupCandidate): boolean {
  return (
    candidate.linkedPRNumber == null &&
    candidate.fallbackPRNumber != null &&
    candidate.fallbackPRSource != null
  )
}

export function hostedReviewOptionArgs(
  candidate: PRBranchLookupCandidate
): [] | [GitHubPRBranchLookupOptions] {
  const options: GitHubPRBranchLookupOptions = {}
  if (candidate.localGitOptions?.wslDistro) {
    options.localGitExecOptions = { wslDistro: candidate.localGitOptions.wslDistro }
  }
  if (shouldAcceptMergedFallbackPR(candidate)) {
    options.acceptMergedFallbackPR = true
  }
  if (typeof candidate.currentHeadOid === 'string' && candidate.currentHeadOid.trim().length > 0) {
    options.currentHeadOid = candidate.currentHeadOid.trim()
  }
  return Object.keys(options).length > 0 ? [options] : []
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
  return reason === 'visible' || reason === 'swr'
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
  if (bypassesFreshnessDelay(reason) || candidate.cachedFetchedAt == null) {
    return false
  }
  return Date.now() - candidate.cachedFetchedAt < refreshIntervalForCandidate(candidate)
}

export function freshRetryAt(candidate: GitHubPRRefreshCandidate): number | null {
  return candidate.cachedFetchedAt == null
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
    cachedHasPR: outcome.kind === 'found',
    cachedPRState: outcome.kind === 'found' ? outcome.pr.state : null,
    cachedChecksStatus: outcome.kind === 'found' ? outcome.pr.checksStatus : null,
    cachedMergeable: outcome.kind === 'found' ? outcome.pr.mergeable : null,
    cachedMergeStateStatus: outcome.kind === 'found' ? (outcome.pr.mergeStateStatus ?? null) : null
  }
}

function refreshIntervalForCandidate(candidate: GitHubPRRefreshCandidate): number {
  if (candidate.cachedPRState === 'closed' || candidate.cachedPRState === 'merged') {
    return 30 * 60_000
  }
  if (candidate.cachedHasPR === false) {
    return NO_REVIEW_REFRESH_INTERVAL_MS
  }
  if (
    candidate.cachedHasPR === true &&
    candidate.cachedPRState === 'open' &&
    candidate.cachedMergeable === 'UNKNOWN' &&
    !hasResolvedMergeStateStatus(candidate.cachedMergeStateStatus)
  ) {
    return 10_000
  }
  if (candidate.cachedChecksStatus === 'success') {
    return 10 * 60_000
  }
  if (candidate.cachedChecksStatus === 'failure') {
    return 3 * 60_000
  }
  if (candidate.cachedChecksStatus === 'pending') {
    return 90_000
  }
  return 60_000
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
