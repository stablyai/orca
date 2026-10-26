import { net } from 'electron'
import { parse } from 'yaml'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const RELEASES_DOWNLOAD_BASE = 'https://github.com/stablyai/orca/releases/download'
const FETCH_TIMEOUT_MS = 5000
const MAX_MANIFEST_PROBE_CANDIDATES = 6

// Atom includes stable and prerelease tags without channel filtering.
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

type ReleaseReadiness = 'ready' | 'not-ready' | 'unavailable'

function getGitHubReleaseAssetReadiness(assetUrl: string): Promise<ReleaseReadiness> {
  return new Promise((resolve) => {
    const request = net.request({ method: 'HEAD', url: assetUrl, redirect: 'manual' })
    let settled = false
    const settle = (readiness: ReleaseReadiness): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(readiness)
    }
    const timeout = setTimeout(() => {
      try {
        request.abort()
      } catch {
        // The request may already have been cancelled by Electron.
      }
      settle('unavailable')
    }, FETCH_TIMEOUT_MS)

    request.on('redirect', (statusCode) => {
      // GitHub's redirect proves existence without fetching the signed storage URL.
      settle(statusCode >= 300 && statusCode < 400 ? 'ready' : 'unavailable')
    })
    request.on('response', (response) => {
      settle(
        response.statusCode === 404
          ? 'not-ready'
          : response.statusCode >= 200 && response.statusCode < 300
            ? 'ready'
            : 'unavailable'
      )
    })
    request.on('error', () => settle('unavailable'))
    try {
      request.end()
    } catch {
      settle('unavailable')
    }
  })
}

async function getReleaseAssetReadiness(tag: string, assetName: string): Promise<ReleaseReadiness> {
  const isRelativeAsset = !/^https?:\/\//i.test(assetName)
  const isGitHubReleaseAsset =
    process.platform === 'win32' &&
    (isRelativeAsset ||
      /^https:\/\/github\.com\/stablyai\/orca\/releases\/download\//i.test(assetName))
  const assetUrl = isRelativeAsset
    ? getReleaseAssetUrl(tag, assetName.split('/').findLast(Boolean) ?? assetName)
    : assetName
  if (isGitHubReleaseAsset) {
    return getGitHubReleaseAssetReadiness(assetUrl)
  }

  try {
    const res = await net.fetch(assetUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (res.status === 404) {
      return 'not-ready'
    }
    return res.ok ? 'ready' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

async function getPlatformManifestReadiness(tag: string): Promise<ReleaseReadiness> {
  try {
    // Feed entries may precede manifests or installer assets; do not offer downloads that would 404.
    const manifestUrl = getReleaseManifestUrl(tag)
    const res = await net.fetch(manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 404) {
      return 'not-ready'
    }
    if (!res.ok) {
      return 'unavailable'
    }
    const manifestText = await res.text()
    let assetNames: string[]
    try {
      assetNames = getManifestAssetNames(manifestText)
    } catch {
      return 'not-ready'
    }
    if (assetNames.length === 0) {
      return 'not-ready'
    }
    const assetResults = await Promise.all(
      assetNames.map((assetName) => getReleaseAssetReadiness(tag, assetName))
    )
    return assetResults.includes('not-ready')
      ? 'not-ready'
      : assetResults.includes('unavailable')
        ? 'unavailable'
        : 'ready'
  } catch {
    return 'unavailable'
  }
}

// Concrete tags keep manifests and downloaded assets on the same release.
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
  releaseFilter?: 'perf'
}

export type FetchNewerReleaseTagsResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

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
  const candidates =
    options.releaseFilter === 'perf'
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
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
