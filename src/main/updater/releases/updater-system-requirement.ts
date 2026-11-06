import { release } from 'node:os'
import type { UpdateInfo } from 'electron-updater'
import type { UnsupportedSystemUpdate } from '../../../shared/update-status-types'
import { compareVersions } from './updater-fallback'

function darwinParts(version: string): number[] | null {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  return parts.every(Number.isInteger) ? parts : null
}

function isDarwinOlder(current: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0)
    if (difference !== 0) {
      return difference < 0
    }
  }
  return false
}

// macOS 11-15 run Darwin 20-24; macOS 26 runs Darwin 25.
function macosMajorForDarwinMajor(darwinMajor: number): number | null {
  if (darwinMajor < 20) {
    return null
  }
  return darwinMajor <= 24 ? darwinMajor - 9 : darwinMajor + 1
}

/** The newer release electron-updater withheld because this Mac's macOS is below its manifest gate. */
export function getUnsupportedSystemUpdate(
  info: Pick<UpdateInfo, 'version' | 'minimumSystemVersion'> | null | undefined,
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  darwinVersion: string = release()
): UnsupportedSystemUpdate | undefined {
  if (platform !== 'darwin' || !info?.minimumSystemVersion) {
    return undefined
  }
  if (compareVersions(info.version, currentVersion) <= 0) {
    return undefined
  }
  const minimum = darwinParts(info.minimumSystemVersion)
  const current = darwinParts(darwinVersion)
  if (!minimum || !current || !isDarwinOlder(current, minimum)) {
    return undefined
  }
  const macosMajor = macosMajorForDarwinMajor(minimum[0])
  return macosMajor === null
    ? undefined
    : { version: info.version, minimumMacosVersion: String(macosMajor) }
}
