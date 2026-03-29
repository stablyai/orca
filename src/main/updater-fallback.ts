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

function parseVersion(value: string): number[] | null {
  const normalized = value.trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    return null
  }
  return normalized.split('.').map((part) => Number(part))
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) {
    return 0
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) {
      return leftPart - rightPart
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
