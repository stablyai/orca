import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import type { NpmPackageInfoResult } from '../../shared/npm-package-info-types'

const OK_OR_NOT_FOUND_TTL_MS = 10 * 60 * 1000
const UNAVAILABLE_TTL_MS = 30 * 1000
/** Never cached: the privacy setting can flip at any moment and a stale
 *  disabled result must not shadow a lookup that would now succeed. */
const LOOKUP_DISABLED_TTL_MS = 0
const MAX_CACHE_ENTRIES = 500

type CacheEntry = { result: NpmPackageInfoResult; expiresAt: number }

function ttlForResult(result: NpmPackageInfoResult): number {
  if (result.status === 'ok' || result.status === 'not-found') {
    return OK_OR_NOT_FOUND_TTL_MS
  }
  if (result.status === 'unavailable') {
    // Why shorter: transient failures (timeout/network) must retry soon
    // rather than sticking around as long as a confirmed answer.
    return UNAVAILABLE_TTL_MS
  }
  return LOOKUP_DISABLED_TTL_MS
}

export type NpmPackageInfoCache = {
  getOrRun(key: string, run: () => Promise<NpmPackageInfoResult>): Promise<NpmPackageInfoResult>
  /** Invalidates every cached entry; called when the privacy setting flips. */
  clear(): void
}

/**
 * Bounded, per-status-TTL cache plus in-flight coalescing for npm package
 * metadata lookups. Not a generic cache — `cache-bridge.ts` is unrelated (a
 * GitHub settings slot); this one is scoped to this domain's HTTP/CLI result.
 */
export function createNpmPackageInfoCache(now: () => number = Date.now): NpmPackageInfoCache {
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<NpmPackageInfoResult>>()

  function readFresh(key: string): NpmPackageInfoResult | undefined {
    const entry = entries.get(key)
    if (!entry) {
      return undefined
    }
    if (entry.expiresAt <= now()) {
      entries.delete(key)
      return undefined
    }
    return entry.result
  }

  function store(key: string, result: NpmPackageInfoResult): void {
    const ttl = ttlForResult(result)
    if (ttl <= 0) {
      return
    }
    // Why delete-then-set: re-inserting moves the key to the end of the
    // Map's insertion order, so "oldest" below stays accurate on refresh.
    entries.delete(key)
    if (entries.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = entries.keys().next().value
      if (oldestKey !== undefined) {
        entries.delete(oldestKey)
      }
    }
    entries.set(key, { result, expiresAt: now() + ttl })
  }

  return {
    async getOrRun(key, run) {
      const cached = readFresh(key)
      if (cached) {
        return cached
      }
      const result = await dedupeInFlightRun(inFlight, key, run)
      store(key, result)
      return result
    },
    clear() {
      entries.clear()
    }
  }
}
