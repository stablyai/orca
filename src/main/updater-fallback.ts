import { app } from 'electron'

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
