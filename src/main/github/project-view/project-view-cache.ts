import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import { githubProjectHost } from '../../../shared/github/project-identity'

export const PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES = 512

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

// Module reloads must discard stale capability results.
const ownerTypeCache = new Map<string, GitHubProjectOwnerType | null>()
// One owner's unsupported parent field must not poison another owner's capability.
export type OptionalProjectItemField = 'parent' | 'subIssuesSummary' | 'linkedPullRequests'
const unsupportedItemFieldsByOwner = new Map<string, ReadonlySet<OptionalProjectItemField>>()
const parentFieldWarningLoggedByOwner = new Map<string, true>()
// Share first-page capability probes per owner.
export const parentFieldProbeInFlight = new Map<string, Promise<void>>()

// Isolate same-name owners across hosts; normalize implicit and explicit github.com to one scope.
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

export function markItemFieldsUnsupported(
  scopeKey: string,
  fields: readonly OptionalProjectItemField[]
): void {
  const unsupported = new Set(getUnsupportedItemFields(scopeKey))
  fields.forEach((field) => unsupported.add(field))
  rememberProjectViewCacheEntry(unsupportedItemFieldsByOwner, scopeKey, unsupported)
}

export function getUnsupportedItemFields(scopeKey: string): ReadonlySet<OptionalProjectItemField> {
  return getProjectViewCacheEntry(unsupportedItemFieldsByOwner, scopeKey) ?? new Set()
}

export function markParentFieldWarningLogged(scopeKey: string): void {
  rememberProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey, true)
}

export function hasParentFieldWarningLogged(scopeKey: string): boolean {
  return getProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey) === true
}

export function _resetProjectViewCachesForTests(): void {
  ownerTypeCache.clear()
  unsupportedItemFieldsByOwner.clear()
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
    parentFieldRetries: unsupportedItemFieldsByOwner.size,
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
  markItemFieldsUnsupported(scopeKey, ['parent'])
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldRetriedForTests(scopeKey: string): boolean {
  return getUnsupportedItemFields(scopeKey).has('parent')
}

/** @internal - exposed for cache-bound tests only. */
export function _markProjectViewParentFieldWarningLoggedForTests(scopeKey: string): void {
  markParentFieldWarningLogged(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldWarningLoggedForTests(scopeKey: string): boolean {
  return hasParentFieldWarningLogged(scopeKey)
}
