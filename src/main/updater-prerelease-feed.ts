import { net } from 'electron'
import { parse } from 'yaml'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const RELEASES_DOWNLOAD_BASE = 'https://github.com/stablyai/orca/releases/download'
const FETCH_TIMEOUT_MS = 5000
const MAX_MANIFEST_PROBE_CANDIDATES = 6

// Why: GitHub's atom feed lists every release (prerelease or stable) in a
// single flat list. Each entry has a /releases/tag/<tag> URL we can mine
// without any channel filtering.
const TAG_HREF_RE = /href="https:\/\/github\.com\/stablyai\/orca\/releases\/tag\/([^"]+)"/g

export function getReleaseDownloadUrl(tag: string): string {
  return `${RELEASES_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`
}

function getPlatformManifestName(): string {
  if (process.platform === 'darwin') {
    return 'latest-mac.yml'
  }
  if (process.platform === 'linux') {
    return 'latest-linux.yml'
  }
  return 'latest.yml'
}

function getReleaseManifestUrl(tag: string): string {
  return `${getReleaseDownloadUrl(tag)}/${getPlatformManifestName()}`
}

function getReleaseAssetUrl(tag: string, assetName: string): string {
  return `${getReleaseDownloadUrl(tag)}/${encodeURIComponent(assetName)}`
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = {
  tag: string
  version: string
}

async function fetchReleaseFeedTags(): Promise<ReleaseFeedTag[] | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await net.fetch(ATOM_FEED_URL, { signal: controller.signal })
    if (!res.ok) {
      return null
    }
    const body = await res.text()
    const tags: ReleaseFeedTag[] = []

    for (const match of body.matchAll(TAG_HREF_RE)) {
      const tag = match[1]
      const version = normalizeTagToVersion(tag)
      if (isValidVersion(version)) {
        tags.push({ tag, version })
      }
    }

    tags.sort((left, right) => compareVersions(right.version, left.version))
    return tags
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

type ManifestAssetEntry = {
  url?: unknown
  path?: unknown
}

function getManifestAssetNames(manifestText: string): string[] {
  const parsed = parse(manifestText) as {
    files?: ManifestAssetEntry[]
    path?: unknown
  } | null

  const names = new Set<string>()
  for (const file of Array.isArray(parsed?.files) ? parsed.files : []) {
    const value = typeof file.url === 'string' ? file.url : file.path
    if (typeof value === 'string' && value.trim()) {
      names.add(value.trim())
    }
  }
  if (typeof parsed?.path === 'string' && parsed.path.trim()) {
    names.add(parsed.path.trim())
  }
  return [...names]
}

async function isReleaseAssetAvailable(tag: string, assetName: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const assetUrl = assetName.startsWith('http')
      ? assetName
      : getReleaseAssetUrl(tag, assetName.split('/').filter(Boolean).at(-1) ?? assetName)
    const res = await net.fetch(assetUrl, { method: 'HEAD', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function hasReadyPlatformManifest(tag: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    // Why: cancelled/draft releases can appear in GitHub's atom feed before
    // they have updater manifests or the ZIP/exe/AppImage assets referenced by
    // those manifests. Pinning to those tags makes download clicks 404.
    const manifestUrl = getReleaseManifestUrl(tag)
    const res = await net.fetch(manifestUrl, { signal: controller.signal })
    if (!res.ok) {
      return false
    }
    const assetNames = getManifestAssetNames(await res.text())
    if (assetNames.length === 0) {
      return false
    }
    const assetResults = await Promise.all(
      assetNames.map((assetName) => isReleaseAssetAvailable(tag, assetName))
    )
    return assetResults.every(Boolean)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Walks the GitHub releases atom feed and returns the tag of the newest
 * release strictly greater than `currentVersion`.
 *
 * Why: electron-updater's GitHubProvider filters the feed by channel, and
 * GitHub's /latest/download redirect can move between check and download.
 * By resolving the newest tag ourselves and pinning the generic provider at
 * `/releases/download/<tag>`, the manifest and downloaded asset stay tied to
 * the same release.
 *
 * Returns null if the fetch fails, the feed has no parseable tags, or
 * nothing in the feed is newer than `currentVersion`.
 */
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
}

export type FetchNewerReleaseTagsResult = {
  tags: string[]
  state: 'ready' | 'no-newer' | 'not-ready' | 'unavailable'
  lastGoodTag?: string
}

export async function fetchNewerReleaseTag(
  currentVersion: string,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string | null> {
  return (await fetchNewerReleaseTags(currentVersion, 1, options))[0] ?? null
}

export async function fetchNewerReleaseTags(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string[]> {
  return (await fetchNewerReleaseTagsWithReadiness(currentVersion, maxTags, options)).tags
}

export async function fetchNewerReleaseTagsWithReadiness(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<FetchNewerReleaseTagsResult> {
  const includePrerelease = options.includePrerelease ?? true
  const tags = await fetchReleaseFeedTags()
  if (!tags || maxTags <= 0) {
    return { tags: [], state: 'unavailable' }
  }

  const candidates = includePrerelease
    ? tags
    : tags.filter(({ version }) => !isPrereleaseVersion(version))
  const newestNewerIndex = candidates.findIndex(
    ({ version }) => compareVersions(version, currentVersion) > 0
  )
  if (newestNewerIndex === -1) {
    return { tags: [], state: 'no-newer' }
  }

  // Why: a cancelled release can leave several feed entries without manifests,
  // but update checks must not stall on an unbounded run of 5s probes.
  const probeCandidates = candidates.slice(
    newestNewerIndex,
    newestNewerIndex + MAX_MANIFEST_PROBE_CANDIDATES
  )
  const manifestResults = await Promise.all(
    probeCandidates.map(async ({ tag, version }) => ({
      tag,
      version,
      hasManifest: await hasReadyPlatformManifest(tag)
    }))
  )

  const primaryIndex = manifestResults.findIndex(
    ({ hasManifest, version }) => hasManifest && compareVersions(version, currentVersion) > 0
  )
  if (primaryIndex === -1) {
    const lastGoodTag = manifestResults.find(({ hasManifest }) => hasManifest)?.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  if (primaryIndex > 0) {
    return { tags: [], state: 'not-ready', lastGoodTag: manifestResults[primaryIndex].tag }
  }

  return {
    tags: manifestResults
      .slice(primaryIndex)
      .filter(({ hasManifest }) => hasManifest)
      .slice(0, maxTags)
      .map(({ tag }) => tag),
    state: 'ready'
  }
}
