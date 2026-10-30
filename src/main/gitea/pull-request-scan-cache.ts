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
const inFlightScans = new Map<string, Promise<RawGiteaPullRequest[]>>()
// Fence in-flight scans so invalidation cannot recache pre-create listings.
const scanGenerations = new Map<string, number>()
const activeScanCounts = new Map<string, number>()

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

/** Gitea/Forgejo lacks head-branch filtering; share pagination so card bursts cannot overload self-hosted servers. */
export async function scanGiteaPullRequests(
  repoKey: string,
  fetchPage: GiteaPullRequestPageFetcher,
  pageLimit: number,
  maxPages: number
): Promise<RawGiteaPullRequest[]> {
  const cached = reusableScanCacheEntry(repoKey)
  if (cached) {
    return cached.pullRequests
  }
  const running = inFlightScans.get(repoKey)
  if (running) {
    return running
  }
  const generation = scanGenerations.get(repoKey) ?? 0
  activeScanCounts.set(repoKey, (activeScanCounts.get(repoKey) ?? 0) + 1)
  const scan = (async () => {
    const pullRequests: RawGiteaPullRequest[] = []
    let completed = true
    for (let page = 1; page <= maxPages; page++) {
      const list = await fetchPage(page)
      if (!list) {
        completed = false
        break
      }
      pullRequests.push(...list)
      if (list.length < pageLimit) {
        break
      }
    }
    if ((scanGenerations.get(repoKey) ?? 0) === generation) {
      rememberScanCacheEntry(repoKey, pullRequests, completed ? SCAN_TTL_MS : FAILED_SCAN_RETRY_MS)
    }
    return pullRequests
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

/** Invalidate after mutations to prevent stale missing-review results. */
export function invalidateGiteaPullRequestScan(repoKey: string): void {
  removeScanCacheEntry(repoKey)
  inFlightScans.delete(repoKey)
  if ((activeScanCounts.get(repoKey) ?? 0) > 0) {
    scanGenerations.set(repoKey, (scanGenerations.get(repoKey) ?? 0) + 1)
  } else {
    scanGenerations.delete(repoKey)
  }
}

export function _resetGiteaPullRequestScanCache(): void {
  for (const repoKey of scanCache.keys()) {
    removeScanCacheEntry(repoKey)
  }
  inFlightScans.clear()
  scanGenerations.clear()
  activeScanCounts.clear()
}

export function _getGiteaPullRequestScanCacheSize(): number {
  return scanCache.size
}
