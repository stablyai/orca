import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { PRSnapshotReply } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getGitHubPRCacheKeyCandidates } from '../../../../shared/github/cache/github-cache-key'

type HostPRCacheStore = {
  getGitHubCache(): PersistedState['githubCache']
  setGitHubCache(cache: PersistedState['githubCache']): void
}

type CachedPREntry = PersistedState['githubCache']['pr'][string]

/** Records a served PR read into this host's own cache: a host with no renderer has no other writer (#50758). */
export function recordHostPROutcome(
  store: HostPRCacheStore,
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>,
  branch: string,
  outcome: PRSnapshotReply
): void {
  // Errors and revalidation receipts carry no answer; keep the last known one.
  if (!('kind' in outcome) || (outcome.kind !== 'found' && outcome.kind !== 'no-pr')) {
    return
  }
  const normalizedBranch = branch.replace(/^refs\/heads\//, '')
  if (!normalizedBranch) {
    return
  }
  // Why the reader's own key: worktree.ps and the cleanup scan look it up with these candidates.
  const key = getGitHubPRCacheKeyCandidates(repo, normalizedBranch)[0]
  const data = outcome.kind === 'found' ? outcome.pr : null
  const cache = store.getGitHubCache()
  const previous = cache.pr[key]
  if (previous && previous.fetchedAt > outcome.fetchedAt) {
    return
  }
  // Unchanged answers skip the write so repeated reads add no persistence churn.
  if (previous && sameCachedData(previous, data)) {
    return
  }
  store.setGitHubCache({
    ...cache,
    pr: { ...cache.pr, [key]: { data, fetchedAt: outcome.fetchedAt } }
  })
}

function sameCachedData(previous: CachedPREntry, data: CachedPREntry['data']): boolean {
  if (previous.data === null || data === null) {
    return previous.data === data
  }
  return JSON.stringify(previous.data) === JSON.stringify(data)
}
