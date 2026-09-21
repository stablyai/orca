import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import { githubProjectHost } from '../../../shared/github/project-identity'

export const PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES = 512

// ─── Module-scope caches (reset on HMR — intentional) ──────────────────

// Why: owners are user-controlled over a long session; bound cache entries to avoid unbounded retention while keeping the hot-owner fast path.
function rememberProjectViewCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES
): void {
  if (cache.has(key)) {
    cache.delete(key)
  }
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done) {
      break
    }
    cache.delete(oldest.value)
  }
}

function getProjectViewCacheEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) {
    return undefined
  }
  const value = cache.get(key) as V
  rememberProjectViewCacheEntry(cache, key, value)
  return value
}

// Why: plain module locals so HMR code swaps re-run capability probes instead of carrying a stale "unsupported" flag.
const ownerTypeCache = new Map<string, GitHubProjectOwnerType | null>()
// Why: keyed per owner (not a process-global flag) so one owner's capability gap doesn't poison others that DO support Issue.parent (bug-scan finding 2).
const parentFieldRetriedByOwner = new Map<string, true>()
const parentFieldWarningLoggedByOwner = new Map<string, true>()
// Why: in-flight promise per owner so concurrent fetchAllItems callers share one probe instead of each racing a duplicate first-page probe.
export const parentFieldProbeInFlight = new Map<string, Promise<void>>()

// Why: GHES owners are a separate namespace and capability surface from
// github.com owners with the same login — scope cache keys by host so one
// host's probe result can't leak into another. Normalize github.com so
// host-less callers share the same probe state as explicitly pinned calls.
export function ownerScopeKey(
  owner: string,
  ownerType: GitHubProjectOwnerType,
  host?: string
): string {
  const base = `${owner}\u0000${ownerType}`
  return `${base}\u0000${githubProjectHost(host)}`
}

function ownerTypeCacheKey(owner: string, host?: string): string {
  return `${owner}\u0000${githubProjectHost(host)}`
}

export function rememberOwnerType(
  owner: string,
  ownerType: GitHubProjectOwnerType | null,
  host?: string
): void {
  rememberProjectViewCacheEntry(ownerTypeCache, ownerTypeCacheKey(owner, host), ownerType)
}

export function getCachedOwnerType(
  owner: string,
  host?: string
): GitHubProjectOwnerType | null | undefined {
  return getProjectViewCacheEntry(ownerTypeCache, ownerTypeCacheKey(owner, host))
}

export function markParentFieldRetried(scopeKey: string): void {
  rememberProjectViewCacheEntry(parentFieldRetriedByOwner, scopeKey, true)
}

export function hasParentFieldRetried(scopeKey: string): boolean {
  return getProjectViewCacheEntry(parentFieldRetriedByOwner, scopeKey) === true
}

export function markParentFieldWarningLogged(scopeKey: string): void {
  rememberProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey, true)
}

export function hasParentFieldWarningLogged(scopeKey: string): boolean {
  return getProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey) === true
}

export function _resetProjectViewCachesForTests(): void {
  ownerTypeCache.clear()
  parentFieldRetriedByOwner.clear()
  parentFieldWarningLoggedByOwner.clear()
  parentFieldProbeInFlight.clear()
}

export function _getProjectViewCacheSizesForTests(): {
  ownerTypes: number
  parentFieldRetries: number
  parentFieldWarnings: number
  parentFieldProbes: number
} {
  return {
    ownerTypes: ownerTypeCache.size,
    parentFieldRetries: parentFieldRetriedByOwner.size,
    parentFieldWarnings: parentFieldWarningLoggedByOwner.size,
    parentFieldProbes: parentFieldProbeInFlight.size
  }
}

/** @internal - exposed for cache-bound tests only. */
export function _rememberProjectViewOwnerTypeForTests(
  owner: string,
  ownerType: GitHubProjectOwnerType | null,
  host?: string
): void {
  rememberOwnerType(owner, ownerType, host)
}

/** @internal - exposed for cache-bound tests only. */
export function _getProjectViewOwnerTypeForTests(
  owner: string,
  host?: string
): GitHubProjectOwnerType | null | undefined {
  return getCachedOwnerType(owner, host)
}

/** @internal - exposed for cache-bound tests only. */
export function _markProjectViewParentFieldRetriedForTests(scopeKey: string): void {
  markParentFieldRetried(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldRetriedForTests(scopeKey: string): boolean {
  return hasParentFieldRetried(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _markProjectViewParentFieldWarningLoggedForTests(scopeKey: string): void {
  markParentFieldWarningLogged(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldWarningLoggedForTests(scopeKey: string): boolean {
  return hasParentFieldWarningLogged(scopeKey)
}
