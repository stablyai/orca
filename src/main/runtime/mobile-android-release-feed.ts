import { net } from 'electron'
import { compareVersions, isValidVersion } from '../updater-fallback'

// Why: published GitHub releases with APK assets are the Android source of truth,
// never a hand-maintained constant. iOS is deliberately absent: it ships through the
// App Store, which auto-updates, and the hard minimum-version cutoff is handled
// separately by ProtocolBlockScreen, so no soft iOS nudge is derived here.

const GITHUB_API_ROOT = 'https://api.github.com/repos/stablyai/orca'
const ANDROID_TAG_REFS_URL = `${GITHUB_API_ROOT}/git/matching-refs/tags/mobile-android-v`
const FETCH_TIMEOUT_MS = 5000
// Why: a mobile build ships ~monthly, so a long TTL keeps this to a few
// unauthenticated GitHub calls per day per host while staying fresh enough.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// Why: a cold failure (autostart before Wi-Fi/VPN associates) would otherwise black
// out the nudge for a full TTL, and mobile schedules no follow-up read once the
// refresh settles. Retry soon instead; a 10-minute floor is ~6 calls/hour against
// GitHub's 60/hr unauthenticated budget.
const FAILED_CACHE_TTL_MS = 10 * 60 * 1000
// Why: only exact Android release tags count, so suffixed RC builds never nudge stable users.
const ANDROID_TAG_REF_RE = /^refs\/tags\/mobile-android-v(\d+\.\d+\.\d+)$/
// Why: malformed/orphaned tags must not turn one refresh into unbounded API fanout.
const MAX_RELEASE_CANDIDATES = 3

type AndroidTagRef = {
  ref?: unknown
}

type AndroidRelease = {
  tag_name?: unknown
  draft?: unknown
  assets?: unknown
}

type CacheState = {
  version: string | null
  fetchedAt: number
  failed: boolean
}

type GitHubResponse = Pick<Response, 'ok' | 'status' | 'json'>
type GitHubFetcher = (url: string, signal: AbortSignal) => Promise<GitHubResponse>

const defaultGitHubFetcher: GitHubFetcher = (url, signal) =>
  net.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'orca-runtime',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal
  })

// Module-level cache shared across every status.get on this host.
let cache: CacheState | null = null
let inFlight: Promise<void> | null = null
let githubFetcher = defaultGitHubFetcher

export function extractAndroidVersionCandidates(entries: AndroidTagRef[]): string[] {
  const versions = new Set<string>()
  for (const entry of entries) {
    if (typeof entry.ref !== 'string') {
      continue
    }
    const match = entry.ref.match(ANDROID_TAG_REF_RE)
    const version = match?.[1]
    if (!version || !isValidVersion(version)) {
      continue
    }
    versions.add(version)
  }
  return [...versions].sort((left, right) => compareVersions(right, left))
}

function releaseHasAndroidApk(release: AndroidRelease, version: string): boolean {
  if (release.draft !== false || release.tag_name !== `mobile-android-v${version}`) {
    return false
  }
  if (!Array.isArray(release.assets)) {
    return false
  }
  return release.assets.some((asset) => {
    if (typeof asset !== 'object' || asset === null) {
      return false
    }
    const name = (asset as { name?: unknown }).name
    return typeof name === 'string' && name.toLowerCase().endsWith('.apk')
  })
}

async function fetchLatestAndroidVersion(): Promise<string | null> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  try {
    const refsResponse = await githubFetcher(ANDROID_TAG_REFS_URL, signal)
    if (!refsResponse.ok) {
      return null
    }
    const refsBody = (await refsResponse.json()) as unknown
    if (!Array.isArray(refsBody)) {
      return null
    }
    const candidates = extractAndroidVersionCandidates(refsBody as AndroidTagRef[]).slice(
      0,
      MAX_RELEASE_CANDIDATES
    )
    for (const version of candidates) {
      const tag = `mobile-android-v${version}`
      const releaseUrl = `${GITHUB_API_ROOT}/releases/tags/${encodeURIComponent(tag)}`
      const releaseResponse = await githubFetcher(releaseUrl, signal)
      if (!releaseResponse.ok) {
        // A tag can briefly precede its release; other failures should not fan out requests.
        if (releaseResponse.status === 404) {
          continue
        }
        return null
      }
      const release = (await releaseResponse.json()) as unknown
      if (
        typeof release === 'object' &&
        release !== null &&
        releaseHasAndroidApk(release as AndroidRelease, version)
      ) {
        return version
      }
    }
    return null
  } catch {
    // Why: fail open — an unreachable/rate-limited/offline host simply advertises
    // no recommendation, and mobile shows no banner.
    return null
  }
}

function refreshInBackground(now: number): void {
  if (inFlight) {
    return
  }
  inFlight = fetchLatestAndroidVersion()
    .then((version) => {
      // Why: keep the last-known version on a failed refresh (null result) so a
      // transient outage doesn't drop an already-correct nudge.
      cache = {
        version: version ?? cache?.version ?? null,
        fetchedAt: now,
        failed: version === null
      }
    })
    .catch(() => {
      cache = { version: cache?.version ?? null, fetchedAt: now, failed: true }
    })
    .finally(() => {
      inFlight = null
    })
}

// Why: status.get is a hot, synchronous RPC, so never block it on the network —
// return the cached value and kick a background refresh when stale
// (stale-while-revalidate). First call returns null (no banner) until the first
// fetch lands, which is the correct fail-open default.
export function getRecommendedAndroidVersion(nowMs: number): string | null {
  const ttl = cache?.failed === true ? FAILED_CACHE_TTL_MS : CACHE_TTL_MS
  if (cache === null || nowMs - cache.fetchedAt > ttl) {
    refreshInBackground(nowMs)
  }
  return cache?.version ?? null
}

export function isAndroidReleaseFeedRefreshPending(): boolean {
  return inFlight !== null
}

// Test-only: reset module cache between cases.
export function __resetAndroidReleaseFeedCacheForTests(): void {
  cache = null
  inFlight = null
  githubFetcher = defaultGitHubFetcher
}

// Test-only: seed the cache with a fresh value so status.get reads it without
// hitting the network.
export function __setAndroidReleaseFeedCacheForTests(version: string | null): void {
  cache = { version, fetchedAt: Date.now(), failed: false }
  inFlight = null
}

export function __setAndroidReleaseFeedFetcherForTests(fetcher: GitHubFetcher): void {
  githubFetcher = fetcher
}
