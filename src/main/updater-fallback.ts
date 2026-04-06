import { app } from 'electron'
import type { UpdateStatus } from '../shared/types'

export function statusesEqual(left: UpdateStatus, right: UpdateStatus): boolean {
  switch (left.state) {
    case 'idle':
      return right.state === 'idle'
    case 'checking':
      return right.state === 'checking' && left.userInitiated === right.userInitiated
    case 'not-available':
      return right.state === 'not-available' && left.userInitiated === right.userInitiated
    case 'available':
      return (
        right.state === 'available' &&
        left.version === right.version &&
        left.releaseUrl === right.releaseUrl &&
        left.manualDownloadUrl === right.manualDownloadUrl
      )
    case 'downloading':
      return (
        right.state === 'downloading' &&
        left.version === right.version &&
        left.percent === right.percent
      )
    case 'downloaded':
      return (
        right.state === 'downloaded' &&
        left.version === right.version &&
        left.releaseUrl === right.releaseUrl
      )
    case 'error':
      return (
        right.state === 'error' &&
        left.message === right.message &&
        left.userInitiated === right.userInitiated
      )
  }
}

const RELEASES_API_URL = 'https://api.github.com/repos/stablyai/orca/releases'

type GitHubReleaseAsset = {
  name?: string
  browser_download_url?: string
}

type GitHubRelease = {
  draft?: boolean
  prerelease?: boolean
  tag_name?: string
  html_url?: string
  assets?: GitHubReleaseAsset[]
}

export type FallbackRelease = {
  version: string
  releaseUrl: string
  manualDownloadUrl: string
}

export function isGitHubReleaseTransitionFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes('unable to find latest version on github') ||
    normalizedMessage.includes('cannot find channel') ||
    normalizedMessage.includes('latest.yml') ||
    normalizedMessage.includes('latest-mac.yml') ||
    normalizedMessage.includes('no published versions on github')
  )
}

/** Identifies update-check failures that are transient or infrastructure-related
 *  (e.g. network blips, GitHub release transitions) and should NOT be surfaced
 *  to the user as errors. */
export function isBenignCheckFailure(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('net::err_failed')) {
    return true
  }

  // GitHub releases can briefly be in a half-published state while the
  // release workflow is creating a draft and uploading update metadata.
  // During that window electron-updater may fail the check even though
  // nothing is wrong on the client side.
  return (
    isGitHubReleaseTransitionFailure(normalizedMessage) ||
    normalizedMessage.includes('no published versions on github')
  )
}

type ParsedVersion = {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  )
  if (!match) {
    return null
  }

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    // We must preserve prerelease ordering because the updater enables
    // allowPrerelease to work around GitHub's latest endpoint. Falling back to
    // "equal" for `1.2.3-rc.1` would silently suppress valid updates.
    prerelease: match[4]?.split('.') ?? []
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return left.localeCompare(right)
}

/** Returns true if the version string contains a prerelease tag (e.g. "-rc.1").
 *  RC releases are only meant to be installed by hand, so the auto-updater must
 *  never offer them. We need this guard because allowPrerelease is enabled on
 *  electron-updater to work around a broken GitHub /releases/latest endpoint,
 *  which means prerelease versions slip through its normal filter. */
export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version)
  // Treat unparseable versions as prerelease so they are rejected early rather
  // than slipping through to downstream guards.
  return parsed === null || parsed.prerelease.length > 0
}

/** Returns negative if left < right, 0 if equal, positive if left > right. */
export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) {
    return 0
  }

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const leftPart = leftVersion.core[index]
    const rightPart = rightVersion.core[index]
    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  const leftPrerelease = leftVersion.prerelease
  const rightPrerelease = rightVersion.prerelease
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0
  }
  if (leftPrerelease.length === 0) {
    return 1
  }
  if (rightPrerelease.length === 0) {
    return -1
  }

  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index]
    const rightPart = rightPrerelease[index]
    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }

    const comparison = compareIdentifiers(leftPart, rightPart)
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}

function scoreAssetForCurrentPlatform(asset: GitHubReleaseAsset): number {
  const assetName = asset.name?.toLowerCase() ?? ''

  if (process.platform === 'darwin') {
    const isDmg = assetName.endsWith('.dmg')
    const isZip = assetName.endsWith('.zip')
    if (!isDmg && !isZip) {
      return -1
    }

    const extensionScore = isDmg ? 2 : 1
    const normalizedArch =
      process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
    if (!normalizedArch) {
      return extensionScore
    }
    if (assetName.includes(normalizedArch)) {
      return 2 + extensionScore
    }
    if (assetName.includes('x64') || assetName.includes('arm64')) {
      return 0
    }
    return extensionScore
  }

  if (process.platform === 'win32') {
    return assetName.endsWith('.exe') ? 1 : -1
  }

  if (assetName.endsWith('.appimage')) {
    return 2
  }
  if (assetName.endsWith('.deb')) {
    return 1
  }
  return -1
}

function getManualDownloadAssetUrl(release: GitHubRelease): string | null {
  const assets = release.assets ?? []
  const platformAsset = assets
    .map((asset) => ({ asset, score: scoreAssetForCurrentPlatform(asset) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.asset

  return platformAsset?.browser_download_url ?? null
}

export async function findFallbackReleaseVersion(): Promise<FallbackRelease | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Orca-Updater'
    }
  })

  if (!response.ok) {
    throw new Error(`GitHub releases lookup failed: ${response.status}`)
  }

  const releases = (await response.json()) as GitHubRelease[]
  const currentVersion = app.getVersion()

  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name || !release.html_url) {
      continue
    }

    const releaseVersion = release.tag_name.replace(/^v/i, '')
    if (compareVersions(releaseVersion, currentVersion) <= 0) {
      continue
    }

    const manualDownloadUrl = getManualDownloadAssetUrl(release)
    if (!manualDownloadUrl) {
      continue
    }

    return {
      version: releaseVersion,
      releaseUrl: release.html_url,
      manualDownloadUrl
    }
  }

  return null
}
