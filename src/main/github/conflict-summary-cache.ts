import type { PRConflictSummary } from '../../shared/types'

// Why 60s: the hottest coordinator cadences that re-derive a CONFLICTING PR
// (10s mergeability-pending, 2.5s manual-pending) previously each ran a
// network fetch; one fetch per base branch per minute matches the 60s minimum
// background refresh cadence, so the tracked base tip is never staler than the
// PR data around it. Manual refresh intentionally shares the window: GitHub's
// own mergeability recompute is async too, and the card self-corrects within
// a minute.
export const CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS = 60_000

// Why bounded: the main process is long-lived; cap the maps so repos and PRs
// that stop refreshing can't accumulate entries forever.
const BASE_OID_CACHE_MAX = 64
const SUMMARY_CACHE_MAX = 128

export type FreshBaseTipResolution =
  | { kind: 'resolved'; oid: string }
  | { kind: 'fallback-unresolved' }

type CachedBaseTipResolution = {
  oid: string | null
  resolvedAt: number
}

type CachedSummary = {
  value: PRConflictSummary | undefined
  // Why: a successful summary is a pure function of two immutable commit OIDs
  // and never goes stale; a failed derivation depends on which objects exist
  // locally, which the next fetch window can change, so it carries an expiry.
  staleAt: number | null
}

const baseOidCache = new Map<string, CachedBaseTipResolution>()
const summaryCache = new Map<string, CachedSummary>()
const inFlightBaseOidResolves = new Map<string, Promise<FreshBaseTipResolution>>()
const inFlightSummaryDerivations = new Map<string, Promise<PRConflictSummary | undefined>>()

// Why: WSL distros have their own git binary, filesystem view, and remote
// access, so cached state must never leak across the host/distro boundary.
export function getConflictSummaryGitRuntimeKey(wslDistro: string | undefined): string {
  return wslDistro ? `wsl:${wslDistro}` : 'local:host'
}

// Why JSON: repo paths and git ref names may contain any printable joiner
// character (git allows `|` in branch names), so a delimiter-joined key could
// alias distinct identities onto one cache entry.
export function buildConflictSummaryCacheKey(...parts: string[]): string {
  return JSON.stringify(parts)
}

export function readFreshBaseTipResolution(baseKey: string): FreshBaseTipResolution | null {
  const entry = baseOidCache.get(baseKey)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.resolvedAt >= CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS) {
    baseOidCache.delete(baseKey)
    return null
  }
  return entry.oid ? { kind: 'resolved', oid: entry.oid } : { kind: 'fallback-unresolved' }
}

export function storeResolvedBaseTip(baseKey: string, oid: string): void {
  setBoundedMapEntry(baseOidCache, baseKey, { oid, resolvedAt: Date.now() }, BASE_OID_CACHE_MAX)
}

export function rememberUnresolvedBaseTip(baseKey: string): void {
  setBoundedMapEntry(
    baseOidCache,
    baseKey,
    { oid: null, resolvedAt: Date.now() },
    BASE_OID_CACHE_MAX
  )
}

export function readCachedSummary(summaryKey: string): CachedSummary | null {
  const entry = summaryCache.get(summaryKey)
  if (!entry) {
    return null
  }
  if (entry.staleAt !== null && Date.now() >= entry.staleAt) {
    summaryCache.delete(summaryKey)
    return null
  }
  return entry
}

export function storeCachedSummary(summaryKey: string, value: PRConflictSummary | undefined): void {
  setBoundedMapEntry(
    summaryCache,
    summaryKey,
    {
      value,
      staleAt: value === undefined ? Date.now() + CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS : null
    },
    SUMMARY_CACHE_MAX
  )
}

export function dedupeBaseOidResolve(
  key: string,
  factory: () => Promise<FreshBaseTipResolution>
): Promise<FreshBaseTipResolution> {
  return dedupeInFlight(inFlightBaseOidResolves, key, factory)
}

export function dedupeSummaryDerivation(
  key: string,
  factory: () => Promise<PRConflictSummary | undefined>
): Promise<PRConflictSummary | undefined> {
  return dedupeInFlight(inFlightSummaryDerivations, key, factory)
}

function dedupeInFlight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = map.get(key)
  if (existing) {
    return existing
  }
  const promise = factory().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next()
    if (oldest.done) {
      return
    }
    map.delete(oldest.value)
  }
}

export function __resetPRConflictSummaryDerivationCachesForTests(): void {
  baseOidCache.clear()
  summaryCache.clear()
  inFlightBaseOidResolves.clear()
  inFlightSummaryDerivations.clear()
}
