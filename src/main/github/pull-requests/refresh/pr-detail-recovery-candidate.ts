import type { PRDetailRecoveryStartArgs } from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

/** The immutable candidate a ticket reads; the host still applies its registered repo routing. */
export function prDetailRecoveryCandidate(
  args: PRDetailRecoveryStartArgs,
  cacheKey = args.cacheKey
): GitHubPRRefreshCandidate | null {
  const { identity } = args
  const linked = identity.linkedPRNumber
  const fallback = linked == null ? identity.fallbackPRNumber : null
  if (identity.provider !== 'github' || !identity.branch || (linked == null && fallback == null)) {
    return null
  }
  return {
    cacheKey,
    repoKind: 'git',
    repoId: identity.repoId,
    repoPath: identity.repoPath,
    branch: identity.branch,
    worktreeId: identity.worktreeId,
    executionHostId: identity.executionHostId,
    currentHeadOid: identity.currentHeadOid,
    linkedPRNumber: linked,
    fallbackPRNumber: fallback,
    fallbackPRSource: fallback == null ? null : identity.fallbackPRSource,
    isSelected: true,
    cachedFetchedAt: null
  }
}
