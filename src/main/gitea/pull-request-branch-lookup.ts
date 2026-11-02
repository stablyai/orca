import { matchesBranch, type RawGiteaPullRequest } from './pull-request-mappers'
import {
  cachedGiteaHeadFilteredScan,
  isGiteaHeadFilterUnsupported,
  rememberGiteaHeadFilterUnsupported,
  scanGiteaPullRequests
} from './pull-request-scan-cache'

// A reused branch name can carry many PRs and Forgejo serialises reviewers
// for every returned one, so the head-filtered page stays small.
const PULL_REQUEST_HEAD_FILTER_LIMIT = 5
const PULL_REQUEST_PAGE_LIMIT = 50
const MAX_PULL_REQUEST_PAGES = 5

type GiteaBranchPullRequestDeps = {
  /** Cache key prefix for one repository (API base + owner/repo). */
  scanKey: string
  /** Resolved API base URL; the head-filter verdict is memoised per host. */
  apiBaseUrl: string
  /** Strict lookups throw on transport failures instead of reading them as "absent". */
  throwOnFailure: boolean
  fetchList: (
    searchParams: Record<string, string | number>
  ) => Promise<RawGiteaPullRequest[] | null>
}

/** Fetch the PR candidates for one branch: a Forgejo `head=` probe when the host honours it, otherwise today's bounded scan. */
export async function fetchGiteaBranchPullRequestCandidates(
  deps: GiteaBranchPullRequestDeps,
  branchName: string
): Promise<RawGiteaPullRequest[]> {
  const filtered = await probeHeadFiltered(deps, branchName)
  if (filtered !== null) {
    return filtered
  }
  return scanGiteaPullRequests(
    // Strict scans must not inherit an empty result produced by a failed lenient scan.
    deps.throwOnFailure ? `${deps.scanKey}::strict` : deps.scanKey,
    (page) =>
      deps.fetchList({ state: 'all', sort: 'recentupdate', page, limit: PULL_REQUEST_PAGE_LIMIT }),
    PULL_REQUEST_PAGE_LIMIT,
    MAX_PULL_REQUEST_PAGES
  )
}

// Forgejo 16+ honours `head=` on the pull list endpoint and filters
// server-side; Gitea and older Forgejo silently ignore the parameter. The
// probe is only trusted when every returned PR matches the branch: a single
// mismatching entry proves the filter was ignored, memoises that verdict per
// API base URL, and degrades this and future lookups to the bounded scan.
// An all-matching response is safe either way without memoising a positive —
// its first entry is exactly what find() over the recentupdate-ordered scan
// returns — and an empty page means "no PR" on both server kinds. Null means
// the fast path cannot answer and the bounded scan must run.
async function probeHeadFiltered(
  deps: GiteaBranchPullRequestDeps,
  branchName: string
): Promise<RawGiteaPullRequest[] | null> {
  if (isGiteaHeadFilterUnsupported(deps.apiBaseUrl)) {
    return null
  }
  return cachedGiteaHeadFilteredScan(`${deps.scanKey}::head::${branchName}`, async () => {
    const filtered = await deps.fetchList({
      state: 'all',
      sort: 'recentupdate',
      head: branchName,
      limit: PULL_REQUEST_HEAD_FILTER_LIMIT
    })
    if (filtered === null) {
      return null
    }
    if (filtered.some((item) => !matchesBranch(item, branchName))) {
      rememberGiteaHeadFilterUnsupported(deps.apiBaseUrl)
      return null
    }
    return filtered
  })
}
