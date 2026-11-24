import { net } from 'electron'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  FETCH_TIMEOUT_MS,
  getPlatformManifestReadiness,
  requestGitHubReleaseHead
} from './updater-release-readiness'

import {
  applyReleaseDelay,
  isReleaseOldEnough,
  type DatedReleaseTag,
  type ReleaseDelayResult
} from './updater-release-delay'
import { listMainRepoReleaseBuildsUntil } from './updater-release-builds'
import type { ReleaseBuild } from '../../../shared/updater/release-channel'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const MAX_MANIFEST_PROBE_CANDIDATES = 6
// Releases past the feed don't change and newer ones come from Atom, so a list that settled the delay stays accurate.
const OLDER_RELEASES_TTL_MS = 6 * 60 * 60 * 1000
let olderReleasesCache: {
  tags: DatedReleaseTag[]
  expiresAt: number
  exhaustive: boolean
} | null = null

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
  minimumVersion?: string
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

  const minimum = options.minimumVersion
  const candidates = (list: ReleaseFeedTag[]): ReleaseFeedTag[] => {
    const channel = selectChannelCandidates(list, includePrerelease, options.releaseFilter)
    return minimum
      ? channel.filter(({ version }) => compareVersions(version, minimum) >= 0)
      : channel
  }
  const channelCandidates = candidates(tags)
  if (!options.minReleaseAgeMs || options.minReleaseAgeMs <= 0) {
    if (channelCandidates.length || !minimum) {
      return resolveNewerReleaseTags(channelCandidates, currentVersion, maxTags)
    }
    const older = await fetchOlderReleaseTags(
      (list) => candidates(list).length > 0,
      options.now ?? Date.now()
    )
    return resolveNewerReleaseTags(
      candidates(mergeReleaseTags(tags, older ?? [])),
      currentVersion,
      maxTags
    )
  }
  const now = options.now ?? Date.now()
  const cutoff = now - options.minReleaseAgeMs
  // Newest-first lists settle the delay at an aged-out newer release or our own release; an older
  // line's recent maintenance release does not prove that history is complete.
  const settlesDelay = (list: ReleaseFeedTag[]): boolean =>
    list.some(({ version }) => compareVersions(version, currentVersion) === 0) ||
    candidates(list).some(
      (entry) =>
        isReleaseOldEnough(entry, cutoff) && compareVersions(entry.version, currentVersion) > 0
    ) ||
    (minimum !== undefined &&
      candidates(list).some(({ version }) => compareVersions(version, minimum) === 0))
  // Atom keeps only ~10 entries, so an aged-out release may predate it.
  // Judge REST pages through the merge so Atom's later `updated` time wins, as it does below.
  const olderTags = settlesDelay(tags)
    ? null
    : await fetchOlderReleaseTags((older) => settlesDelay(mergeReleaseTags(tags, older)), now)
  const allTags = olderTags ? mergeReleaseTags(tags, olderTags) : tags
  const allCandidates = candidates(allTags)
  const { eligible, releaseDelay } = applyReleaseDelay(
    allCandidates,
    allTags,
    currentVersion,
    options.minReleaseAgeMs,
    now
  )
  const bypassDelayForMinimum = minimum !== undefined && eligible.length === 0
  const result = await resolveNewerReleaseTags(
    bypassDelayForMinimum ? allCandidates.toReversed() : eligible,
    currentVersion,
    bypassDelayForMinimum ? 1 : maxTags
  )
  return { ...result, releaseDelay }
}

// Perf builds require explicit opt-in, even when semver considers them newer.
function selectChannelCandidates(
  tags: ReleaseFeedTag[],
  includePrerelease: boolean,
  releaseFilter: FetchNewerReleaseTagOptions['releaseFilter']
): ReleaseFeedTag[] {
  if (releaseFilter === 'perf') {
    return tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
  }
  return includePrerelease
    ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
    : tags.filter(({ version }) => !isPrereleaseVersion(version))
}

async function fetchOlderReleaseTags(
  settlesDelay: (tags: ReleaseFeedTag[]) => boolean,
  now: number
): Promise<ReleaseFeedTag[] | null> {
  if (
    olderReleasesCache &&
    olderReleasesCache.expiresAt > now &&
    (olderReleasesCache.exhaustive || settlesDelay(olderReleasesCache.tags))
  ) {
    return olderReleasesCache.tags
  }
  try {
    const builds = await listMainRepoReleaseBuildsUntil((listed) =>
      settlesDelay(listed.map(toDatedReleaseTag))
    )
    const tags = builds.map(toDatedReleaseTag)
    // An unsettled list ran to the last page or the cap, so refetching within the TTL finds nothing more.
    olderReleasesCache = {
      tags,
      expiresAt: now + OLDER_RELEASES_TTL_MS,
      exhaustive: !settlesDelay(tags)
    }
    return tags
  } catch {
    // Rate limits or outages keep the Atom-only result, which holds the update (fail closed).
    return null
  }
}

function toDatedReleaseTag({ tag, version, publishedAt }: ReleaseBuild): ReleaseFeedTag {
  const releasedAt = publishedAt ? Date.parse(publishedAt) : Number.NaN
  return { tag, version, releasedAt: Number.isNaN(releasedAt) ? null : releasedAt }
}

// Atom entries win; REST pages can repeat a release published while paging.
function mergeReleaseTags(
  feedTags: ReleaseFeedTag[],
  olderTags: ReleaseFeedTag[]
): ReleaseFeedTag[] {
  const byTag = new Map<string, ReleaseFeedTag>()
  for (const entry of [...feedTags, ...olderTags]) {
    if (!byTag.has(entry.tag)) {
      byTag.set(entry.tag, entry)
    }
  }
  return [...byTag.values()].sort((left, right) => compareVersions(right.version, left.version))
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
