import type { RawGiteaPullRequest } from './pull-request-mappers'

export type GiteaPullRequestPageFetcher = (page: number) => Promise<RawGiteaPullRequest[] | null>

type GiteaPullRequestScanEntry = {
  expiresAt: number
  expirationTimer: ReturnType<typeof setTimeout>
  pullRequests: RawGiteaPullRequest[]
}

// Why: long enough to absorb a push-event burst that refreshes every worktree
// card at once, short enough that a PR opened outside Orca shows up promptly.
const SCAN_TTL_MS = 30_000
// Why: a short failure cooldown still coalesces rapid card retries without
// turning a transient outage into a 30-second authoritative "no PR" result.
const FAILED_SCAN_RETRY_MS = 3_000
// Why: each entry can retain hundreds of full PR payloads, so TTL alone is not
// enough protection when many repositories are opened during one app session.
const MAX_SCAN_CACHE_ENTRIES = 32

const scanCache = new Map<string, GiteaPullRequestScanEntry>()
const inFlightScans = new Map<string, Promise<RawGiteaPullRequest[]>>()
// Why: an invalidation (PR just created) must also defeat a scan already in
// flight — otherwise that scan finishes afterwards and re-caches a listing
// from before the mutation, hiding the new PR for a full TTL.
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
  // Keep the cap useful for users actively switching among several repositories.
  scanCache.delete(repoKey)
  scanCache.set(repoKey, entry)
  return entry
}

/**
 * Why: every worktree card resolves its branch by paginating the same
 * /repos/{repo}/pulls listing — Gitea/Forgejo have no head-branch filter.
 * Self-hosted forges serve that endpoint slowly, and a push event refreshes
 * all cards at once, so per-card scans multiplied one page walk into hundreds
 * of requests and OOM-killed a small Forgejo pod (#8807). All concurrent
 * callers share one in-flight scan per repo, and the result is cached briefly
 * so a burst costs a single page walk.
 */
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

/** Drop the cached scan after a mutation Orca itself performed (PR create),
 *  so the next card refresh sees the new PR instead of a stale miss. */
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
