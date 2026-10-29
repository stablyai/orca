import { noteProviderCacheAnswer } from '../source-control/hosted-review-provider-read'
import type { RawGiteaPullRequest } from './pull-request-mappers'

export type GiteaPullRequestPageFetcher = (page: number) => Promise<RawGiteaPullRequest[] | null>

type GiteaPullRequestScanEntry = {
  expiresAt: number
  expirationTimer: ReturnType<typeof setTimeout>
  pullRequests: RawGiteaPullRequest[]
}

// Absorb card-refresh bursts while promptly discovering externally created PRs.
const SCAN_TTL_MS = 30_000
// Retry failures sooner than successful listings so outages do not look like durable misses.
const FAILED_SCAN_RETRY_MS = 3_000
// Each payload can retain hundreds of PRs; TTL alone does not bound session memory.
const MAX_SCAN_CACHE_ENTRIES = 32

const scanCache = new Map<string, GiteaPullRequestScanEntry>()
const inFlightScans = new Map<string, Promise<RawGiteaPullRequest[] | null>>()
// Fence in-flight scans so invalidation cannot recache pre-create listings.
const scanGenerations = new Map<string, number>()
const activeScanCounts = new Map<string, number>()

// Forgejo 16+ filters /pulls by `head=`; Gitea and older Forgejo silently
// ignore the parameter. Remember the rejection per API base URL so such hosts
// pay one probe per TTL instead of one wasted request per lookup. Only the
// negative verdict is memoised: a positive is re-proven by matchesBranch on
// every fast lookup, and an empty page is unambiguous on both server kinds.
const HEAD_FILTER_UNSUPPORTED_TTL_MS = 6 * 60 * 60 * 1000
const headFilterUnsupportedUntil = new Map<string, number>()

export function rememberGiteaHeadFilterUnsupported(apiBaseUrl: string): void {
  headFilterUnsupportedUntil.set(apiBaseUrl, Date.now() + HEAD_FILTER_UNSUPPORTED_TTL_MS)
}

export function isGiteaHeadFilterUnsupported(apiBaseUrl: string): boolean {
  const until = headFilterUnsupportedUntil.get(apiBaseUrl)
  if (until === undefined) {
    return false
  }
  if (Date.now() >= until) {
    headFilterUnsupportedUntil.delete(apiBaseUrl)
    return false
  }
  return true
}

function removeScanCacheEntry(repoKey: string, expected?: GiteaPullRequestScanEntry): void {
  const entry = scanCache.get(repoKey)
  if (!entry || (expected && entry !== expected)) {
    return
  }
  clearTimeout(entry.expirationTimer)
  scanCache.delete(repoKey)
}

function rememberScanCacheEntry(
  repoKey: string,
  pullRequests: RawGiteaPullRequest[],
  ttlMs: number
): void {
  removeScanCacheEntry(repoKey)
  let entry!: GiteaPullRequestScanEntry
  const expirationTimer = setTimeout(() => removeScanCacheEntry(repoKey, entry), ttlMs)
  expirationTimer.unref()
  entry = {
    expiresAt: Date.now() + ttlMs,
    expirationTimer,
    pullRequests
  }
  scanCache.set(repoKey, entry)
  while (scanCache.size > MAX_SCAN_CACHE_ENTRIES) {
    const oldestKey = scanCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    removeScanCacheEntry(oldestKey)
  }
}

function reusableScanCacheEntry(repoKey: string): GiteaPullRequestScanEntry | null {
  const entry = scanCache.get(repoKey)
  if (!entry) {
    return null
  }
  if (Date.now() >= entry.expiresAt) {
    removeScanCacheEntry(repoKey, entry)
    return null
  }
  // Refresh recency for users switching among repositories.
  scanCache.delete(repoKey)
  scanCache.set(repoKey, entry)
  return entry
}

type GiteaPullRequestScanRun = () => Promise<{
  pullRequests: RawGiteaPullRequest[]
  completed: boolean
} | null>

// Shared per-key cache core: TTL, in-flight coalescing and the invalidation
// generation fence. A null run outcome is not cached — the caller falls back
// to another scan path for that lookup.
async function cachedGiteaPullRequestScan(
  repoKey: string,
  run: GiteaPullRequestScanRun
): Promise<RawGiteaPullRequest[] | null> {
  const cached = reusableScanCacheEntry(repoKey)
  if (cached) {
    noteProviderCacheAnswer()
    return cached.pullRequests
  }
  const running = inFlightScans.get(repoKey)
  if (running) {
    noteProviderCacheAnswer()
    return running
  }
  const generation = scanGenerations.get(repoKey) ?? 0
  activeScanCounts.set(repoKey, (activeScanCounts.get(repoKey) ?? 0) + 1)
  const scan = (async () => {
    const outcome = await run()
    if (!outcome) {
      return null
    }
    if ((scanGenerations.get(repoKey) ?? 0) === generation) {
      rememberScanCacheEntry(
        repoKey,
        outcome.pullRequests,
        outcome.completed ? SCAN_TTL_MS : FAILED_SCAN_RETRY_MS
      )
    }
    return outcome.pullRequests
  })()
  inFlightScans.set(repoKey, scan)
  try {
    return await scan
  } finally {
    if (inFlightScans.get(repoKey) === scan) {
      inFlightScans.delete(repoKey)
    }
    const activeScans = (activeScanCounts.get(repoKey) ?? 1) - 1
    if (activeScans > 0) {
      activeScanCounts.set(repoKey, activeScans)
    } else {
      activeScanCounts.delete(repoKey)
      scanGenerations.delete(repoKey)
    }
  }
}

/** Paged listing fallback shared by card bursts so self-hosted servers are not flooded. */
export async function scanGiteaPullRequests(
  repoKey: string,
  fetchPage: GiteaPullRequestPageFetcher,
  pageLimit: number,
  maxPages: number
): Promise<RawGiteaPullRequest[]> {
  const pullRequests = await cachedGiteaPullRequestScan(repoKey, async () => {
    const listed: RawGiteaPullRequest[] = []
    let completed = true
    for (let page = 1; page <= maxPages; page++) {
      const list = await fetchPage(page)
      if (!list) {
        completed = false
        break
      }
      listed.push(...list)
      if (list.length < pageLimit) {
        break
      }
    }
    return { pullRequests: listed, completed }
  })
  return pullRequests ?? []
}

/**
 * One-shot probe cache for the Forgejo `head=` fast path. Entries only ever
 * hold a verified match or an unambiguous empty page, so the strict and
 * lenient lookups can share one key without inheriting a failed scan. A probe
 * failure is likewise never shared as a rejection: the shared promise resolves
 * to a miss and each caller falls back to its own bounded scan, whose
 * throwOnFailure mode decides the final outcome (absence for lenient, a thrown
 * error for strict).
 */
export async function cachedGiteaHeadFilteredScan(
  repoKey: string,
  probe: () => Promise<RawGiteaPullRequest[] | null>
): Promise<RawGiteaPullRequest[] | null> {
  return cachedGiteaPullRequestScan(repoKey, async () => {
    let pullRequests: RawGiteaPullRequest[] | null
    try {
      pullRequests = await probe()
    } catch {
      // The fast path is an optimisation: its failure says nothing about the
      // answer, and the probe key is shared by strict and lenient lookups, so
      // a rejection here would leak into whichever caller joined second.
      return null
    }
    return pullRequests === null ? null : { pullRequests, completed: true }
  })
}

/** Invalidate after mutations to prevent stale missing-review results. */
function invalidateGiteaPullRequestScan(repoKey: string): void {
  removeScanCacheEntry(repoKey)
  inFlightScans.delete(repoKey)
  if ((activeScanCounts.get(repoKey) ?? 0) > 0) {
    scanGenerations.set(repoKey, (scanGenerations.get(repoKey) ?? 0) + 1)
  } else {
    scanGenerations.delete(repoKey)
  }
}

/** Invalidate every scan variant cached for a repository (base, strict, head-filtered). */
export function invalidateGiteaPullRequestScanTree(repoKey: string): void {
  const affected = new Set<string>()
  for (const key of scanCache.keys()) {
    if (key === repoKey || key.startsWith(`${repoKey}::`)) {
      affected.add(key)
    }
  }
  for (const key of inFlightScans.keys()) {
    if (key === repoKey || key.startsWith(`${repoKey}::`)) {
      affected.add(key)
    }
  }
  for (const key of affected) {
    invalidateGiteaPullRequestScan(key)
  }
}

export function _resetGiteaPullRequestScanCache(): void {
  for (const repoKey of scanCache.keys()) {
    removeScanCacheEntry(repoKey)
  }
  inFlightScans.clear()
  scanGenerations.clear()
  activeScanCounts.clear()
  headFilterUnsupportedUntil.clear()
}

export function _getGiteaPullRequestScanCacheSize(): number {
  return scanCache.size
}
