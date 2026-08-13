import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import type { ProjectRef } from './project-ref-parser'

const CACHE_MAX_ENTRIES = 512

type CachedProjectRef = { value: ProjectRef | null; expiresAt: number }

const cache = new Map<string, CachedProjectRef>()

export function getCachedProjectRef(cacheKey: string): ProjectRef | null | undefined {
  const cached = cache.get(cacheKey)
  if (!cached) {
    return undefined
  }
  if (cached.expiresAt > Date.now()) {
    return cached.value
  }
  cache.delete(cacheKey)
  return undefined
}

export function rememberProjectRef(cacheKey: string, value: ProjectRef | null): void {
  // A missing/unauthenticated remote can change without an observable mutation.
  cache.set(cacheKey, {
    value,
    expiresAt: value === null ? Date.now() + NEGATIVE_ENTRY_TTL_MS : Number.POSITIVE_INFINITY
  })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}

export function clearProjectRefCache(): void {
  cache.clear()
}

export function getProjectRefCacheSize(): number {
  return cache.size
}
