import {
  applyPRCacheResult,
  shouldPreserveMergedPRForFallbackMiss
} from '../../shared/github/pr-cache-result'
import { cachedPRCandidateFields } from '../../shared/github/pr-refresh-selection'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import type { RuntimeStore } from './runtime-store-contract'

export function applyWorkspaceReviewCacheResult(
  store: Pick<RuntimeStore, 'getGitHubCache' | 'setGitHubCache'>,
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
): GitHubPRRefreshCandidate | null {
  if (outcome.kind === 'upstream-error') {
    return null
  }
  const cache = store.getGitHubCache()
  const existing = cache.pr[candidate.cacheKey]
  if (existing && existing.fetchedAt > outcome.fetchedAt) {
    return null
  }
  const pr = outcome.kind === 'found' ? outcome.pr : null
  const preserve = shouldPreserveMergedPRForFallbackMiss({
    currentPR: existing?.data,
    nextPR: pr,
    currentHeadOid: candidate.currentHeadOid,
    linkedPRNumber: candidate.linkedPRNumber,
    rejectedPRUrls: outcome.kind === 'no-pr' ? outcome.rejectedPRUrls : undefined
  })
  const next = applyPRCacheResult(
    cache.pr,
    candidate.cacheKey,
    pr,
    outcome.fetchedAt,
    true,
    preserve,
    candidate.currentHeadOid
  )
  if (next !== cache.pr) {
    store.setGitHubCache?.({ ...cache, pr: next })
  }
  // The completed lookup confirms retained scheduling facts without rewriting fetch provenance.
  return preserve && existing
    ? {
        ...candidate,
        ...cachedPRCandidateFields(
          { ...existing, fetchedAt: outcome.fetchedAt },
          candidate.currentHeadOid
        )
      }
    : null
}
