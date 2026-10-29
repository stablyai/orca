import { getStoreGitHubParticipants } from './github-participant-store'
import type { RuntimeStore } from './runtime-store-contract'

export function readSharedGitHubCache(
  store: Pick<RuntimeStore, 'getGitHubCache' | 'getProfileStorageDirectory'>
): ReturnType<RuntimeStore['getGitHubCache']> {
  // Shared cache keys have no participant authority; keep views uncached in participant mode.
  return getStoreGitHubParticipants(store)?.hasEnabledRepos()
    ? { pr: {}, issue: {} }
    : store.getGitHubCache()
}
