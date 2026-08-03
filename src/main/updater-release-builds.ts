import { net } from 'electron'
import {
  getReleaseRepoForChannel,
  getVersionChannel,
  normalizeTagToVersion,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from '../shared/release-channel'
import { isValidVersion } from './updater-fallback'

const FETCH_TIMEOUT_MS = 8000
const MAX_LISTED_BUILDS = 100

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
}

function parseReleaseEntry(entry: GitHubReleaseEntry, repo: string): ReleaseBuild | null {
  if (typeof entry.tag_name !== 'string' || entry.draft === true) {
    return null
  }
  const tag = entry.tag_name
  const version = normalizeTagToVersion(tag)
  const channel = getVersionChannel(version)
  if (!isValidVersion(version) || !channel) {
    return null
  }
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
        : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`
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
export async function listReleaseBuilds(channel: ReleaseChannel): Promise<ReleaseBuild[]> {
  const repo = getReleaseRepoForChannel(channel)
  const res = await net.fetch(getReleasesApiUrl(repo), {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`No releases repository found at ${repo}.`)
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub rate limit reached. Try again in a few minutes.')
    }
    throw new Error(`Could not list ${channel} builds (HTTP ${res.status}).`)
  }
  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) {
    throw new Error(`Could not read the ${channel} release list.`)
  }
  const builds = payload
    .map((entry) => parseReleaseEntry(entry as GitHubReleaseEntry, repo))
    .filter((build): build is ReleaseBuild => build !== null)
    // Why: the main repo serves both stable and rc, so filter to the asked-for channel.
    .filter((build) => build.channel === channel)
  return sortReleaseBuildsNewestFirst(builds)
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
