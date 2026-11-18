import {
  getVersionChannel,
  MAIN_RELEASE_REPO,
  normalizeTagToVersion
} from '../../../shared/updater/release-channel'
import type {
  UpdateReleaseHistory,
  UpdateReleaseNote
} from '../../../shared/updater/update-status-types'
import { compareVersions, isValidVersion } from './updater-fallback'
import { fetchReleaseListPage, RELEASES_PER_PAGE } from './updater-release-builds'

const MAX_PAGES = 3
// Bound the status payload, which also reaches paired clients.
const MAX_RELEASES = 25
const MAX_NOTES_LENGTH = 12_000

type GitHubRelease = {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  published_at?: unknown
  html_url?: unknown
  body?: unknown
}

function parseStableRelease(entry: GitHubRelease | null): UpdateReleaseNote | null {
  if (typeof entry?.tag_name !== 'string' || entry.draft === true || entry.prerelease === true) {
    return null
  }
  const version = normalizeTagToVersion(entry.tag_name)
  if (getVersionChannel(version) !== 'stable') {
    return null
  }
  const notes = typeof entry.body === 'string' ? entry.body.trim() : ''
  return {
    version,
    publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
    notes: notes.length > MAX_NOTES_LENGTH ? `${notes.slice(0, MAX_NOTES_LENGTH)}…` : notes,
    releaseUrl:
      typeof entry.html_url === 'string'
        ? entry.html_url
        : `https://github.com/${MAIN_RELEASE_REPO}/releases/tag/${encodeURIComponent(entry.tag_name)}`
  }
}

async function loadReleaseHistory(
  availableVersion: string,
  installedVersion: string
): Promise<UpdateReleaseHistory | null> {
  const newer = new Map<string, UpdateReleaseNote>()
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { res } = await fetchReleaseListPage(MAIN_RELEASE_REPO, page)
    if (!res.ok) {
      return null
    }
    const payload: unknown = await res.json()
    if (!Array.isArray(payload)) {
      return null
    }
    // GitHub lists by creation date, not version, so read every bounded page.
    for (const entry of payload) {
      const release = parseStableRelease(entry)
      if (!release) {
        continue
      }
      // compareVersions ignores build metadata, so 1.4.258+custom.1 counts as 1.4.258.
      if (
        compareVersions(release.version, installedVersion) > 0 &&
        compareVersions(release.version, availableVersion) <= 0
      ) {
        newer.set(release.version, release)
      }
    }
    if (payload.length < RELEASES_PER_PAGE) {
      break
    }
  }
  if (newer.size === 0) {
    return null
  }
  const releases = [...newer.values()].sort((a, b) => compareVersions(b.version, a.version))
  return {
    installedVersion,
    releases: releases.slice(0, MAX_RELEASES),
    newerReleaseCount: releases.length
  }
}

type CachedHistory = { key: string; history: Promise<UpdateReleaseHistory | null> }

let cached: CachedHistory | null = null

function startLoad(key: string, availableVersion: string, installedVersion: string): CachedHistory {
  const entry: CachedHistory = {
    key,
    history: loadReleaseHistory(availableVersion, installedVersion).catch(() => null)
  }
  // Retry a failed listing on the next check instead of pinning the fallback.
  void entry.history.then((history) => {
    if (history === null && cached === entry) {
      cached = null
    }
  })
  return entry
}

/** Stable releases in (installed, available], newest first; null when they cannot be listed. */
export function fetchReleaseHistory(
  availableVersion: string,
  installedVersion: string
): Promise<UpdateReleaseHistory | null> {
  if (getVersionChannel(availableVersion) !== 'stable' || !isValidVersion(installedVersion)) {
    return Promise.resolve(null)
  }
  const key = `${installedVersion}->${availableVersion}`
  if (cached?.key !== key) {
    cached = startLoad(key, availableVersion, installedVersion)
  }
  return cached.history
}
