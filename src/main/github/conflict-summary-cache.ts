import type { PRConflictSummary } from '../../shared/github/pull-request-types'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'

// Throttle even manual refreshes to one base fetch per minute; GitHub recomputes mergeability asynchronously.
export const CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS = 60_000

// TTL alone cannot bound retained repositories and PRs in a long-lived process.
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
  // Success depends on immutable OIDs; failure can recover when later fetches supply missing objects.
  staleAt: number | null
}

const baseOidCache = new Map<string, CachedBaseTipResolution>()
const summaryCache = new Map<string, CachedSummary>()
const inFlightBaseOidResolves = new Map<string, Promise<FreshBaseTipResolution>>()
const inFlightSummaryDerivations = new Map<string, Promise<PRConflictSummary | undefined>>()

// Git binaries, filesystems and remote access differ across native/WSL runtimes.
export function getConflictSummaryGitRuntimeKey(wslDistro: string | undefined): string {
  return wslDistro ? `wsl:${wslDistro}` : 'local:host'
}

// Paths and refs may contain printable delimiters; structural encoding prevents key collisions.
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
  return dedupeInFlightRun(inFlightBaseOidResolves, key, factory)
}

export function dedupeSummaryDerivation(
  key: string,
  factory: () => Promise<PRConflictSummary | undefined>
): Promise<PRConflictSummary | undefined> {
  return dedupeInFlightRun(inFlightSummaryDerivations, key, factory)
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
