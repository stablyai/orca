import { net } from 'electron'
import { compareVersions, isValidVersion } from './updater-fallback'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const RELEASES_DOWNLOAD_BASE = 'https://github.com/stablyai/orca/releases/download'
const FETCH_TIMEOUT_MS = 5000

// Why: GitHub's atom feed lists every release (prerelease or stable) in a
// single flat list. Each entry has a /releases/tag/<tag> URL we can mine
// without any channel filtering.
const TAG_HREF_RE = /href="https:\/\/github\.com\/stablyai\/orca\/releases\/tag\/([^"]+)"/g

export function getReleaseDownloadUrl(tag: string): string {
  return `${RELEASES_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

/**
 * Walks the GitHub releases atom feed and returns the tag of the newest
 * release strictly greater than `currentVersion`, regardless of channel.
 *
 * Why: electron-updater's GitHubProvider filters the feed by channel — when
 * the running build is an RC, it only considers other RC/alpha/beta entries,
 * so an RC user never gets offered the next *stable* release. By resolving
 * the newest tag ourselves (any channel) and then pinning the generic
 * provider at `/releases/download/<tag>`, we sidestep that channel filter
 * entirely. Generic provider just reads the manifest at the URL we give it.
 *
 * Returns null if the fetch fails, the feed has no parseable tags, or
 * nothing in the feed is newer than `currentVersion`.
 */
export async function fetchNewerReleaseTag(currentVersion: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await net.fetch(ATOM_FEED_URL, { signal: controller.signal })
    if (!res.ok) {
      return null
    }
    const body = await res.text()

    let bestTag: string | null = null
    let bestVersion: string | null = null

    for (const match of body.matchAll(TAG_HREF_RE)) {
      const tag = match[1]
      const version = normalizeTagToVersion(tag)
      if (!isValidVersion(version)) {
        continue
      }
      if (compareVersions(version, currentVersion) <= 0) {
        continue
      }
      if (bestVersion === null || compareVersions(version, bestVersion) > 0) {
        bestTag = tag
        bestVersion = version
      }
    }

    return bestTag
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
