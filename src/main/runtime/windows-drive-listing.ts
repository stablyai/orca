import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export type DriveListing = {
  resolvedPath: string
  entries: { name: string; isDirectory: boolean; isSymlink: boolean }[]
}

// Windows has no shared filesystem root, so `/` represents mounted drives.
export function isServerDriveListRequest(
  pathValue: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /^[\\/]+$/.test(pathValue.trim())
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

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
      } catch {
        return null
      }
    })
  )
  return {
    resolvedPath: '/',
    entries: roots
      .filter((root): root is string => root !== null)
      .map((root) => ({ name: root, isDirectory: true, isSymlink: false }))
  }
}
