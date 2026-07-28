import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { FilesystemPathFlavor } from '../../shared/types'

export type DriveListing = {
  resolvedPath: string
  entries: { name: string; isDirectory: boolean; isSymlink: boolean }[]
  pathFlavor: FilesystemPathFlavor
}

// Windows has no shared filesystem root, so `/` represents mounted drives.
export function isServerDriveListRequest(
  pathValue: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /^[\\/]+$/.test(pathValue.trim())
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const EXPECTED_UNAVAILABLE_DRIVE_CODES = new Set(['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM'])

export async function listWindowsDrives(
  statPath: (p: string) => Promise<Stats> = stat
): Promise<DriveListing> {
  // Keep the separator because bare `M:` is drive-relative on Windows.
  const roots = await Promise.all(
    [...DRIVE_LETTERS].map(async (letter) => {
      const root = `${letter}:\\`
      try {
        const stats = await statPath(root)
        return stats.isDirectory() ? root : null
      } catch (error) {
        if (isExpectedUnavailableDriveError(error)) {
          return null
        }
        throw error
      }
    })
  )
  return {
    resolvedPath: '/',
    pathFlavor: 'win32',
    entries: roots
      .filter((root): root is string => root !== null)
      .map((root) => ({ name: root, isDirectory: true, isSymlink: false }))
  }
}

function isExpectedUnavailableDriveError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    EXPECTED_UNAVAILABLE_DRIVE_CODES.has(error.code)
  )
}
