import { net } from 'electron'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  FETCH_TIMEOUT_MS,
  getPlatformManifestReadiness,
  requestGitHubReleaseHead
} from './updater-release-readiness'

import {
  applyReleaseDelay,
  type DatedReleaseTag,
  type ReleaseDelayResult
} from './updater-release-delay'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const MAX_MANIFEST_PROBE_CANDIDATES = 6

// Atom includes stable and prerelease tags without channel filtering.
const ENTRY_RE = /<entry>([\s\S]*?)<\/entry>/g
const TAG_HREF_RE = /href="https:\/\/github\.com\/stablyai\/orca\/releases\/tag\/([^"]+)"/
const ENTRY_UPDATED_RE = /<updated>([^<]+)<\/updated>/

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = DatedReleaseTag

export function isPerfPrereleaseTag(tag: string): boolean {
  const version = normalizeTagToVersion(tag)
  const match = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-.]+)(?:\+[0-9A-Za-z-.]+)?$/)
  const identifiers = match?.[1]?.split('.') ?? []
  return (
    identifiers.length === 3 &&
    identifiers[0] === 'rc' &&
    /^\d+$/.test(identifiers[1]) &&
    identifiers[2] === 'perf'
  )
}

async function fetchReleaseFeedTags(): Promise<ReleaseFeedTag[] | null> {
  try {
    const res = await net.fetch(ATOM_FEED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      return null
    }
    const body = await res.text()
    const tags: ReleaseFeedTag[] = []

    for (const entry of body.matchAll(ENTRY_RE)) {
      const tag = entry[1].match(TAG_HREF_RE)?.[1]
      if (!tag) {
        continue
      }
      const version = normalizeTagToVersion(tag)
      if (isValidVersion(version)) {
        const releasedAt = Date.parse(entry[1].match(ENTRY_UPDATED_RE)?.[1] ?? '')
        tags.push({ tag, version, releasedAt: Number.isNaN(releasedAt) ? null : releasedAt })
      }
    }

    tags.sort((left, right) => compareVersions(right.version, left.version))
    return tags
  } catch {
    return null
  }
}

export async function fetchLatestStableReleaseTag(): Promise<string | null> {
  try {
    // Resolve only the release-page redirect; installer redirects continue on to signed storage URLs.
    const latestUrl = 'https://github.com/stablyai/orca/releases/latest'
    const response = await requestGitHubReleaseHead(latestUrl)
    if (!response?.redirectUrl || response.statusCode < 300 || response.statusCode >= 400) {
      return null
    }
    const target = new URL(response.redirectUrl, latestUrl)
    const match = target.pathname.match(/^\/stablyai\/orca\/releases\/tag\/([^/]+)$/)
    if (target.origin !== 'https://github.com' || !match) {
      return null
    }
    const tag = decodeURIComponent(match[1])
    const version = normalizeTagToVersion(tag)
    if (!isValidVersion(version) || isPrereleaseVersion(version)) {
      return null
    }
    return (await getPlatformManifestReadiness(tag)) === 'ready' ? tag : null
  } catch {
    return null
  }
}

// Concrete tags keep manifests and downloaded assets on the same release.
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
  releaseFilter?: 'perf'
  /** User update delay: only releases public at least this long are offered. */
  minReleaseAgeMs?: number
  now?: number
}

type FetchNewerReleaseTagsBaseResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

export type FetchNewerReleaseTagsResult = FetchNewerReleaseTagsBaseResult & {
  releaseDelay?: ReleaseDelayResult
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
  if (maxTags <= 0) {
    return { tags: [], state: 'no-newer' }
  }
  const tags = await fetchReleaseFeedTags()
  if (!tags) {
    return { tags: [], state: 'unavailable', unavailableReason: 'feed' }
  }

  // Perf builds require explicit opt-in, even when semver considers them newer.
  const channelCandidates =
    options.releaseFilter === 'perf'
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
  if (!options.minReleaseAgeMs || options.minReleaseAgeMs <= 0) {
    return resolveNewerReleaseTags(channelCandidates, currentVersion, maxTags)
  }
  const { eligible, releaseDelay } = applyReleaseDelay(
    channelCandidates,
    tags,
    currentVersion,
    options.minReleaseAgeMs,
    options.now ?? Date.now()
  )
  return {
    ...(await resolveNewerReleaseTags(eligible, currentVersion, maxTags)),
    releaseDelay
  }
}

async function resolveNewerReleaseTags(
  candidates: ReleaseFeedTag[],
  currentVersion: string,
  maxTags: number
): Promise<FetchNewerReleaseTagsBaseResult> {
  const newestNewerIndex = candidates.findIndex(
    ({ version }) => compareVersions(version, currentVersion) > 0
  )
  if (newestNewerIndex === -1) {
    return { tags: [], state: 'no-newer' }
  }

  // Bound probes when cancelled releases leave multiple entries without manifests.
  const probeCandidates = candidates.slice(
    newestNewerIndex,
    newestNewerIndex + MAX_MANIFEST_PROBE_CANDIDATES
  )
  const manifestResults = await Promise.all(
    probeCandidates.map(async ({ tag, version }) => ({
      tag,
      version,
      readiness: await getPlatformManifestReadiness(tag)
    }))
  )

  const primaryIndex = manifestResults.findIndex(
    ({ readiness, version }) =>
      readiness === 'ready' && compareVersions(version, currentVersion) > 0
  )
  if (primaryIndex === -1) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    const lastGoodTag = manifestResults.find(({ readiness }) => readiness === 'ready')?.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  if (primaryIndex > 0) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    return { tags: [], state: 'not-ready', lastGoodTag: manifestResults[primaryIndex].tag }
  }

  return {
    tags: manifestResults
      .slice(primaryIndex)
      .filter(({ readiness }) => readiness === 'ready')
      .slice(0, maxTags)
      .map(({ tag }) => tag),
    state: 'ready'
  }
}
