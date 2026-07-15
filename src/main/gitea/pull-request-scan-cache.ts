import type { RawGiteaPullRequest } from './pull-request-mappers'

export type GiteaPullRequestPageFetcher = (page: number) => Promise<RawGiteaPullRequest[] | null>

type GiteaPullRequestScanEntry = {
  fetchedAt: number
  pullRequests: RawGiteaPullRequest[]
}

// Why: long enough to absorb a push-event burst that refreshes every worktree
// card at once, short enough that a PR opened outside Orca shows up promptly.
const SCAN_TTL_MS = 30_000

const scanCache = new Map<string, GiteaPullRequestScanEntry>()
const inFlightScans = new Map<string, Promise<RawGiteaPullRequest[]>>()

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
  const cached = scanCache.get(repoKey)
  if (cached && Date.now() - cached.fetchedAt < SCAN_TTL_MS) {
    return cached.pullRequests
  }
  const running = inFlightScans.get(repoKey)
  if (running) {
    return running
  }
  const scan = (async () => {
    const pullRequests: RawGiteaPullRequest[] = []
    for (let page = 1; page <= maxPages; page++) {
      const list = await fetchPage(page)
      if (list) {
        pullRequests.push(...list)
      }
      if (!list || list.length < pageLimit) {
        break
      }
    }
    scanCache.set(repoKey, { fetchedAt: Date.now(), pullRequests })
    return pullRequests
  })()
  inFlightScans.set(repoKey, scan)
  try {
    return await scan
  } finally {
    inFlightScans.delete(repoKey)
  }
}

/** Drop the cached scan after a mutation Orca itself performed (PR create),
 *  so the next card refresh sees the new PR instead of a stale miss. */
export function invalidateGiteaPullRequestScan(repoKey: string): void {
  scanCache.delete(repoKey)
}

export function _resetGiteaPullRequestScanCache(): void {
  scanCache.clear()
  inFlightScans.clear()
}
