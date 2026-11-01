import { net } from 'electron'
import {
  findInstallerAssetName,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasInstallableArtifactForPlatform,
  normalizeTagToVersion,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from '../shared/release-channel'
import { parseRetryAfterHeaderMs } from '../shared/retry-after-header'
import { getGhRateLimitBlockedUntilMs, recordGhPrimaryRateLimit } from './git/gh-rate-limit-breaker'
import { isValidVersion } from './updater-fallback'
import { rejectReleaseApiToken, resolveReleaseApiToken } from './updater-release-api-token'
import { UpdaterCodedError } from './updater/updater-coded-error'

const FETCH_TIMEOUT_MS = 8000
const MAX_LISTED_BUILDS = 100
const RETRY_AFTER_MAX_MS = 60 * 60_000

function getReleasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${MAX_LISTED_BUILDS}`
}

function fetchReleases(repo: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return net.fetch(getReleasesApiUrl(repo), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
}

function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
  )
}

// Retry-After marks secondary limits: neither trip the primary breaker nor retry immediately.
function isPrimaryRateLimited(res: Response): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' && !res.headers.has('retry-after')
}

// Retry-After gives the requested wait; the primary reset can overstate a secondary throttle.
export function rateLimitResetAtMs(headers: Headers, nowMs: number): number | null {
  const retryAfterMs = parseRetryAfterHeaderMs(
    headers.get('retry-after'),
    RETRY_AFTER_MAX_MS,
    nowMs
  )
  if (retryAfterMs !== null) {
    return nowMs + retryAfterMs
  }
  const resetEpochSeconds = Number(headers.get('x-ratelimit-reset'))
  return resetEpochSeconds > 0 ? resetEpochSeconds * 1000 : null
}

function rateLimitError(resetAtMs: number | null, nowMs: number, signedIn: boolean): Error {
  if (resetAtMs === null) {
    return new UpdaterCodedError(signedIn ? 'rateLimitedSoon' : 'rateLimitedSoonSignedOut')
  }
  const minutes = Math.ceil((resetAtMs - nowMs) / 60_000)
  if (minutes <= 1) {
    return new UpdaterCodedError(signedIn ? 'rateLimitedInMinute' : 'rateLimitedInMinuteSignedOut')
  }
  return new UpdaterCodedError(
    signedIn ? 'rateLimitedInMinutes' : 'rateLimitedInMinutesSignedOut',
    { count: minutes }
  )
}

function releaseListError(
  res: Response,
  repo: string,
  channel: ReleaseChannel,
  signedIn: boolean
): Error {
  if (res.status === 404) {
    return new UpdaterCodedError('releaseRepoNotFound', { repo })
  }
  if (isRateLimited(res)) {
    const nowMs = Date.now()
    return rateLimitError(rateLimitResetAtMs(res.headers, nowMs), nowMs, signedIn)
  }
  return new UpdaterCodedError('releaseListFailed', { channel, status: res.status })
}

export function getReleaseDownloadUrlForRepo(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`
}

type GitHubReleaseEntry = {
  tag_name?: unknown
  name?: unknown
  draft?: unknown
  published_at?: unknown
  html_url?: unknown
  assets?: unknown
}

function readAssetNames(assets: unknown): string[] {
  if (!Array.isArray(assets)) {
    return []
  }
  return assets
    .map((asset) => (asset as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string')
}

function parseReleaseEntry(
  entry: GitHubReleaseEntry,
  repo: string,
  platform: NodeJS.Platform
): ReleaseBuild | null {
  if (typeof entry.tag_name !== 'string' || entry.draft === true) {
    return null
  }
  const tag = entry.tag_name
  const version = normalizeTagToVersion(tag)
  const channel = getVersionChannel(version)
  if (!isValidVersion(version) || !channel) {
    return null
  }
  // Platform release legs publish independently; offer only artifacts that actually exist.
  const assetNames = readAssetNames(entry.assets)
  if (!hasInstallableArtifactForPlatform(platform, assetNames)) {
    return null
  }
  const installerAsset = findInstallerAssetName(platform, assetNames)
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  return {
    tag,
    version,
    channel,
    name: name && name !== tag ? name : null,
    publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
    releaseUrl:
      typeof entry.html_url === 'string'
        ? entry.html_url
        : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    installerUrl: installerAsset
      ? `${getReleaseDownloadUrlForRepo(repo, tag)}/${encodeURIComponent(installerAsset)}`
      : null
  }
}

// REST exposes older builds the short Atom feed omits; use only for explicit picker requests.
export async function listReleaseBuilds(
  channel: ReleaseChannel,
  platform: NodeJS.Platform = process.platform
): Promise<ReleaseBuild[]> {
  const repo = getReleaseRepoForChannel(channel)
  // Skip a known-exhausted token bucket and try the separate per-IP quota.
  const credential = await resolveReleaseApiToken()
  const tokenBucketBlocked =
    credential !== null &&
    getGhRateLimitBlockedUntilMs('core', Date.now(), credential.rateLimitScope) !== null
  const token = tokenBucketBlocked ? null : (credential?.token ?? null)
  let signedIn = credential !== null
  let res = await fetchReleases(repo, token)
  if (token && res.status === 401) {
    // A rejected token must not prevent listing a public repo unauthenticated.
    rejectReleaseApiToken()
    signedIn = false
    res = await fetchReleases(repo, null)
  } else if (token && isRateLimited(res) && isPrimaryRateLimited(res)) {
    // The per-IP quota may still be available; mark the token bucket spent before retrying.
    const resetAtMs = rateLimitResetAtMs(res.headers, Date.now())
    if (resetAtMs !== null && credential) {
      recordGhPrimaryRateLimit('core', resetAtMs, credential.rateLimitScope)
    }
    res = await fetchReleases(repo, null)
  }
  if (!res.ok) {
    throw releaseListError(res, repo, channel, signedIn)
  }
  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) {
    throw new UpdaterCodedError('releaseListUnreadable', { channel })
  }
  const builds = payload
    .map((entry) => parseReleaseEntry(entry as GitHubReleaseEntry, repo, platform))
    .filter((build): build is ReleaseBuild => build !== null)
    .filter((build) => build.channel === channel)
  return sortReleaseBuildsNewestFirst(builds)
}

export type ResolvedTargetBuild = {
  tag: string
  version: string
  feedUrl: string
}

export function resolveTargetBuild(channel: ReleaseChannel, tag: string): ResolvedTargetBuild {
  const version = normalizeTagToVersion(tag)
  if (!isValidVersion(version)) {
    throw new UpdaterCodedError('invalidReleaseTag', { tag })
  }
  const repo = getReleaseRepoForChannel(channel)
  return { tag, version, feedUrl: getReleaseDownloadUrlForRepo(repo, tag) }
}
