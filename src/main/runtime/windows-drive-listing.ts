import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export type DriveListing = {
  resolvedPath: string
  entries: { name: string; isDirectory: boolean; isSymlink: boolean }[]
}

// Windows has no single filesystem root, so a host-root browse (`/`) must be
// answered with the mounted drives or remote clients can never leave `C:\`.
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
  // Entry names keep the trailing separator (`M:\`) — a bare `M:` is
  // drive-relative on Windows and would resolve against that drive's cwd.
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
