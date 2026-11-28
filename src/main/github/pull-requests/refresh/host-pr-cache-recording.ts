import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { PRSnapshotReply } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getGitHubPRCacheKeyCandidates } from '../../../../shared/github/cache/github-cache-key'
import { withBoundedCacheEntry } from '../../../../shared/github/cache/bounded-cache-entries'

export type HostPRCacheStore = {
  getGitHubCache(): PersistedState['githubCache']
  setGitHubCache(cache: PersistedState['githubCache']): void
}

export type HostPRCacheRepo = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>

/** What the read asked for; a miss without a linked PR is weaker evidence than a recorded merged PR. */
export type HostPRReadRequest = {
  linkedPRNumber?: number | null
  currentHeadOid?: string | null
}

/** The cache key worktree.ps and the cleanup scan read for this repo branch, or null without a branch. */
export function hostPRCacheKey(repo: HostPRCacheRepo, branch: string): string | null {
  const normalizedBranch = branch.replace(/^refs\/heads\//, '')
  return normalizedBranch ? getGitHubPRCacheKeyCandidates(repo, normalizedBranch)[0] : null
}

/** Records a served PR read into this host's own cache: a host with no renderer has no other writer (#50758).
 *  Returns the key when the read answered, written or not, so callers can count it as checked. */
export function recordHostPROutcome(
  store: HostPRCacheStore,
  repo: HostPRCacheRepo,
  branch: string,
  outcome: PRSnapshotReply,
  request: HostPRReadRequest = {}
): string | null {
  // Errors and revalidation receipts carry no answer; keep the last known one.
  if (!('kind' in outcome) || (outcome.kind !== 'found' && outcome.kind !== 'no-pr')) {
    return null
  }
  const key = hostPRCacheKey(repo, branch)
  if (!key) {
    return null
  }
  const data = outcome.kind === 'found' ? outcome.pr : null
  const cache = store.getGitHubCache()
  const previous = cache.pr[key]
  const keepsPrevious =
    (previous && previous.fetchedAt > outcome.fetchedAt) ||
    (outcome.kind === 'no-pr' &&
      preservesMergedPRForMiss(previous?.data, request, outcome.rejectedPRUrls)) ||
    // Unchanged answers skip the write so repeated reads add no persistence churn.
    (previous && isDeepStrictEqual(previous.data, data))
  if (!keepsPrevious) {
    store.setGitHubCache({
      ...cache,
      pr: withBoundedCacheEntry(cache.pr, key, { data, fetchedAt: outcome.fetchedAt })
    })
  }
  return key
}

/** Mirrors the renderer's fallback-miss rule: a miss without a linked PR keeps a merged PR whose head is still checked out. */
function preservesMergedPRForMiss(
  current: PRInfo | null | undefined,
  request: HostPRReadRequest,
  rejectedPRUrls: readonly string[] | undefined
): boolean {
  if (
    request.linkedPRNumber != null ||
    current?.state !== 'merged' ||
    rejectedPRUrls?.includes(current.url) ||
    !current.headSha
  ) {
    return false
  }
  const head = request.currentHeadOid?.trim()
  // Fail safe: a miss that can't name the checked-out head keeps the merged evidence.
  return !head || current.headSha === head || current.confirmedContainedHeadOid === head
}
