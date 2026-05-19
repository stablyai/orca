import { net } from 'electron'
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

async function hasPlatformManifest(tag: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    // Why: cancelled/draft releases can appear in GitHub's atom feed before
    // they have updater manifests. Pinning to those tags makes every check 404.
    const res = await net.fetch(getReleaseManifestUrl(tag), { signal: controller.signal })
    return res.ok
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
  const includePrerelease = options.includePrerelease ?? true
  const tags = await fetchReleaseFeedTags()
  if (!tags || maxTags <= 0) {
    return []
  }

  const candidates = includePrerelease
    ? tags
    : tags.filter(({ version }) => !isPrereleaseVersion(version))
  const newestNewerIndex = candidates.findIndex(
    ({ version }) => compareVersions(version, currentVersion) > 0
  )
  if (newestNewerIndex === -1) {
    return []
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
      hasManifest: await hasPlatformManifest(tag)
    }))
  )

  const primaryIndex = manifestResults.findIndex(
    ({ hasManifest, version }) => hasManifest && compareVersions(version, currentVersion) > 0
  )
  if (primaryIndex === -1) {
    return []
  }

  return manifestResults
    .slice(primaryIndex)
    .filter(({ hasManifest }) => hasManifest)
    .slice(0, maxTags)
    .map(({ tag }) => tag)
}
