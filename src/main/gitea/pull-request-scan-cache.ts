import type { RawGiteaPullRequest } from './pull-request-mappers'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

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
export const GITEA_SCAN_CACHE_MAX_ENTRIES = 32
export const GITEA_SCAN_MAX_IN_FLIGHT = 32
export const GITEA_SCAN_REPO_KEY_MAX_BYTES = 4 * 1024
export const GITEA_SCAN_CACHE_ENTRY_MAX_PULL_REQUESTS = 250
export const GITEA_SCAN_CACHE_ENTRY_MAX_BYTES = 512 * 1024

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
  if (!isRetainablePullRequestListing(pullRequests)) {
    return
  }
  let entry!: GiteaPullRequestScanEntry
  const expirationTimer = setTimeout(() => removeScanCacheEntry(repoKey, entry), ttlMs)
  expirationTimer.unref()
  entry = {
    expiresAt: Date.now() + ttlMs,
    expirationTimer,
    pullRequests
  }
  scanCache.set(repoKey, entry)
  while (scanCache.size > GITEA_SCAN_CACHE_MAX_ENTRIES) {
    const oldestKey = scanCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    removeScanCacheEntry(oldestKey)
  }
}

function isRetainableRepoKey(repoKey: string): boolean {
  return !measureUtf8ByteLength(repoKey, {
    stopAfterBytes: GITEA_SCAN_REPO_KEY_MAX_BYTES
  }).exceededLimit
}

function isRetainablePullRequestListing(pullRequests: RawGiteaPullRequest[]): boolean {
  if (pullRequests.length > GITEA_SCAN_CACHE_ENTRY_MAX_PULL_REQUESTS) {
    return false
  }
  let remainingBytes = GITEA_SCAN_CACHE_ENTRY_MAX_BYTES - pullRequests.length * 128
  if (remainingBytes < 0) {
    return false
  }
  for (const pullRequest of pullRequests) {
    const values = [
      pullRequest.title,
      pullRequest.state,
      pullRequest.html_url,
      pullRequest.updated_at,
      pullRequest.head?.ref,
      pullRequest.head?.label,
      pullRequest.head?.sha
    ]
    for (const value of values) {
      if (typeof value !== 'string') {
        continue
      }
      const measured = measureUtf8ByteLength(value, { stopAfterBytes: remainingBytes })
      if (measured.exceededLimit) {
        return false
      }
      remainingBytes -= measured.byteLength
    }
  }
  return true
}

async function collectPullRequests(
  fetchPage: GiteaPullRequestPageFetcher,
  pageLimit: number,
  maxPages: number
): Promise<{ completed: boolean; pullRequests: RawGiteaPullRequest[] }> {
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
  return { completed, pullRequests }
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
  if (!isRetainableRepoKey(repoKey)) {
    return (await collectPullRequests(fetchPage, pageLimit, maxPages)).pullRequests
  }
  const cached = reusableScanCacheEntry(repoKey)
  if (cached) {
    return cached.pullRequests
  }
  const running = inFlightScans.get(repoKey)
  if (running) {
    return running
  }
  if (inFlightScans.size >= GITEA_SCAN_MAX_IN_FLIGHT) {
    return (await collectPullRequests(fetchPage, pageLimit, maxPages)).pullRequests
  }
  const generation = scanGenerations.get(repoKey) ?? 0
  activeScanCounts.set(repoKey, (activeScanCounts.get(repoKey) ?? 0) + 1)
  const scan = (async () => {
    const { completed, pullRequests } = await collectPullRequests(fetchPage, pageLimit, maxPages)
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

export function _getGiteaPullRequestScanState(): {
  cached: number
  inFlight: number
  active: number
  generations: number
} {
  return {
    cached: scanCache.size,
    inFlight: inFlightScans.size,
    active: activeScanCounts.size,
    generations: scanGenerations.size
  }
}
