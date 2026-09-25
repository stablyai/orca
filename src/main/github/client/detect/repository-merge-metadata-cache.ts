import type { GitHubPRMergeMethodSettings } from '../../../../shared/github/pull-request-types'
export const MERGE_QUEUE_CACHE_TTL_MS = 10 * 60 * 1000

export const MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS = 60 * 1000

export const MERGE_QUEUE_CACHE_MAX_ENTRIES = 256

export type GitHubRepositoryMergeMetadata = {
  mergeQueueRequired: boolean | null
  autoMergeAllowed: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
}

export const repositoryMergeMetadataCache = new Map<
  string,
  { value: GitHubRepositoryMergeMetadata; expiresAt: number }
>()

export function pruneRepositoryMergeMetadataCache(now = Date.now()): void {
  for (const [cacheKey, cached] of repositoryMergeMetadataCache) {
    if (cached.expiresAt <= now) {
      repositoryMergeMetadataCache.delete(cacheKey)
    }
  }
  while (repositoryMergeMetadataCache.size > MERGE_QUEUE_CACHE_MAX_ENTRIES) {
    const oldestKey = repositoryMergeMetadataCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    repositoryMergeMetadataCache.delete(oldestKey)
  }
}

export function cacheRepositoryMergeMetadata(
  cacheKey: string,
  value: GitHubRepositoryMergeMetadata,
  ttlMs: number
): void {
  const now = Date.now()
  pruneRepositoryMergeMetadataCache(now)
  // Why: merge metadata is keyed by user-controlled branch names; keep the cache bounded across many short-lived branches.
  repositoryMergeMetadataCache.delete(cacheKey)
  repositoryMergeMetadataCache.set(cacheKey, {
    value,
    expiresAt: now + ttlMs
  })
  pruneRepositoryMergeMetadataCache(now)
}

export function _resetMergeQueueCacheForTests(): void {
  repositoryMergeMetadataCache.clear()
}

export function _getMergeQueueCacheSizeForTests(): number {
  return repositoryMergeMetadataCache.size
}
