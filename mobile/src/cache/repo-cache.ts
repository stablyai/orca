// Why: repo metadata is mostly decorative and changes rarely. Keeping a short
// host-scoped cache lets workspace creation open from the last known list while
// a fresh repo.list refresh happens in the background.

import { MobileRpcListCache } from './mobile-rpc-list-cache'

const MAX_AGE_MS = 60_000
export const MOBILE_REPO_CACHE_MAX_ENTRIES = 20
export const MOBILE_REPO_CACHE_MAX_ITEMS_PER_HOST = 10_000
export const MOBILE_REPO_CACHE_MAX_RETAINED_BYTES = 16 * 1024 * 1024

const cache = new MobileRpcListCache(
  MAX_AGE_MS,
  MOBILE_REPO_CACHE_MAX_ENTRIES,
  MOBILE_REPO_CACHE_MAX_ITEMS_PER_HOST,
  MOBILE_REPO_CACHE_MAX_RETAINED_BYTES
)

export function setCachedRepos(hostId: string, repos: unknown[]): void {
  cache.set(hostId, repos)
}

export function getCachedRepos(hostId: string): unknown[] | null {
  return cache.get(hostId)
}

/** Test-only: clear process-lifetime cache state between cases. */
export function resetRepoCacheForTests(): void {
  cache.clear()
}
