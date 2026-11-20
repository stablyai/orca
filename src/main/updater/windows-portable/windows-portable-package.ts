import { join } from 'node:path'
import { isWindowsPortablePackage } from '../linux-package/linux-update-package-type'
import { getReleaseDownloadUrl } from '../releases/updater-release-readiness'

export const WINDOWS_PORTABLE_ARCHIVE_NAME = 'orca-windows-x64-portable.zip'
export const WINDOWS_PORTABLE_SHA256_NAME = `${WINDOWS_PORTABLE_ARCHIVE_NAME}.sha256`
export const WINDOWS_PORTABLE_ROOT_DIR = 'Orca-portable'
export const WINDOWS_PORTABLE_DATA_DIR = 'data'
export const WINDOWS_PORTABLE_PUBLISHER = 'SignPath Foundation'

export const WINDOWS_PORTABLE_REQUIRED_SIGNED_EXECUTABLES = [
  'Orca.exe',
  'resources/bin/orca.exe',
  'resources/bin/orca-administrator-restart.exe',
  'resources/bin/orca-agent-hook.exe',
  'resources/bin/orca-portable-updater.exe'
] as const

export function isWindowsPortableInstall(): boolean {
  return isWindowsPortablePackage()
}

export function getWindowsPortableReleaseTag(version: string): string {
  const trimmed = version.trim()
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

export function getWindowsPortableAssetUrls(version: string): {
  tag: string
  archiveUrl: string
  sha256Url: string
} {
  const tag = getWindowsPortableReleaseTag(version)
  const base = getReleaseDownloadUrl(tag)
  return {
    tag,
    archiveUrl: `${base}/${encodeURIComponent(WINDOWS_PORTABLE_ARCHIVE_NAME)}`,
    sha256Url: `${base}/${encodeURIComponent(WINDOWS_PORTABLE_SHA256_NAME)}`
  }
}

export function parseSha256ChecksumFile(content: string, expectedFileName: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line)
    if (!match) {
      continue
    }
    const hash = match[1].toLowerCase()
    const fileName = match[2]?.trim()
    if (!fileName || fileName.toLowerCase() === expectedFileName.toLowerCase()) {
      return hash
    }
  }
  throw new Error(`No valid SHA-256 entry found for ${expectedFileName}`)
}

export function resolveBundledPortableUpdaterPath(resourcesPath: string): string {
  return join(resourcesPath, 'bin', 'orca-portable-updater.exe')
}
