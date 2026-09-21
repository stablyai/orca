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
import { isValidVersion } from './updater-fallback'

const FETCH_TIMEOUT_MS = 8000
const MAX_LISTED_BUILDS = 100
const BUILDS_CACHE_TTL_MS = 3 * 60_000
const TOKEN_CACHE_TTL_MS = 5 * 60_000

type BuildsCacheEntry = {
  builds: ReleaseBuild[]
  cachedAt: number
}

const buildsCache = new Map<string, BuildsCacheEntry>()
let tokenCache: { token: string | null; cachedAt: number } | null = null

function buildsCacheKey(channel: ReleaseChannel, platform: NodeJS.Platform): string {
  return `${channel}\0${platform}`
}

export type ListReleaseBuildsOptions = {
  force?: boolean
  nowMs?: number
}

// Why: resolve user's gh token to draw from the 5,000 req/hr quota instead of unauthenticated IP pool.
export async function resolveGitHubAuthToken(nowMs = Date.now()): Promise<string | null> {
  if (tokenCache && nowMs - tokenCache.cachedAt < TOKEN_CACHE_TTL_MS) {
    return tokenCache.token
  }
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (envToken && envToken.trim()) {
    tokenCache = { token: envToken.trim(), cachedAt: nowMs }
    return tokenCache.token
  }
  try {
    const { ghExecFileAsync } = await import('./git/runner')
    const { stdout } = await ghExecFileAsync(['auth', 'token'], {
      timeout: 3000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    const token = stdout.replace(/\r?\n/g, '').trim()
    const resolved = token || null
    tokenCache = { token: resolved, cachedAt: nowMs }
    return resolved
  } catch {
    // Why: cache failure briefly so an unauthenticated or missing gh binary does not re-spawn on every call.
    tokenCache = { token: null, cachedAt: nowMs }
    return null
  }
}

export function clearReleaseBuildsCacheForTests(): void {
  buildsCache.clear()
  tokenCache = null
}

function isRateLimitResponse(
  status: number,
  res: { headers?: { get?: (name: string) => string | null } }
): boolean {
  if (status === 429) {
    return true
  }
  if (status === 403) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining')
    return remaining === '0' || remaining === null || remaining === undefined
  }
  return false
}

function formatRateLimitErrorMessage(
  res: { headers?: { get?: (name: string) => string | null } },
  nowMs: number
): string {
  const resetHeader = res.headers?.get?.('x-ratelimit-reset')
  if (resetHeader) {
    const resetEpochSec = Number(resetHeader)
    if (!Number.isNaN(resetEpochSec) && resetEpochSec > 0) {
      const diffMs = resetEpochSec * 1000 - nowMs
      if (diffMs > 0) {
        const minutes = Math.ceil(diffMs / 60_000)
        return `GitHub rate limit reached. Resets in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      }
    }
  }
  return 'GitHub rate limit reached. Try again in a few minutes.'
}

function getReleasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${MAX_LISTED_BUILDS}`
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
  // Why filter on assets rather than on a per-channel platform table: a release
  // is published as soon as one platform's leg finishes, and a leg can fail
  // outright. Asking what the release actually carries covers both without the
  // picker ever offering a row whose download 404s.
  const assetNames = readAssetNames(entry.assets)
  if (!hasInstallableArtifactForPlatform(platform, assetNames)) {
    return null
  }
  const installerAsset = findInstallerAssetName(platform, assetNames)
  // Why null when it merely repeats the tag: GitHub titles an untitled release
  // with its tag name, and hourlies predating the naming change were created that
  // way too. Neither says anything the version beside it does not.
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

/**
 * Lists published releases for a channel so the dev picker can offer an exact
 * build — including older ones — to jump to.
 *
 * Why the REST API rather than the atom feed the routine update path uses: the
 * feed caps at the 10 newest entries, which cannot express "jump back to
 * yesterday's hourly". This runs only on explicit dev interaction, so its
 * unauthenticated rate limit never touches background checks.
 */
export async function listReleaseBuilds(
  channel: ReleaseChannel,
  platform: NodeJS.Platform = process.platform,
  options?: ListReleaseBuildsOptions
): Promise<ReleaseBuild[]> {
  const now = options?.nowMs ?? Date.now()
  const cacheKey = buildsCacheKey(channel, platform)
  if (!options?.force) {
    const cached = buildsCache.get(cacheKey)
    if (cached && now - cached.cachedAt < BUILDS_CACHE_TTL_MS) {
      return cached.builds
    }
  }

  const repo = getReleaseRepoForChannel(channel)
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const authToken = await resolveGitHubAuthToken(now)
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`
  }

  const res = await net.fetch(getReleasesApiUrl(repo), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`No releases repository found at ${repo}.`)
    }
    if (isRateLimitResponse(res.status, res)) {
      throw new Error(formatRateLimitErrorMessage(res, now))
    }
    if (res.status === 403) {
      throw new Error(`Could not list ${channel} builds (HTTP 403 forbidden).`)
    }
    throw new Error(`Could not list ${channel} builds (HTTP ${res.status}).`)
  }
  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) {
    throw new Error(`Could not read the ${channel} release list.`)
  }
  const builds = payload
    .map((entry) => parseReleaseEntry(entry as GitHubReleaseEntry, repo, platform))
    .filter((build): build is ReleaseBuild => build !== null)
    // Why: the main repo serves both stable and rc, so filter to the asked-for channel.
    .filter((build) => build.channel === channel)
  const sorted = sortReleaseBuildsNewestFirst(builds)
  buildsCache.set(cacheKey, { builds: sorted, cachedAt: now })
  return sorted
}

export type ResolvedTargetBuild = {
  tag: string
  version: string
  feedUrl: string
}

/** Resolves a tag the user picked into a pinned generic feed URL. */
export function resolveTargetBuild(channel: ReleaseChannel, tag: string): ResolvedTargetBuild {
  const version = normalizeTagToVersion(tag)
  if (!isValidVersion(version)) {
    throw new Error(`"${tag}" is not a valid release tag.`)
  }
  const repo = getReleaseRepoForChannel(channel)
  return { tag, version, feedUrl: getReleaseDownloadUrlForRepo(repo, tag) }
}
