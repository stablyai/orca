// Free space on the filesystems a runtime host writes to, for the desktop's low-disk banner.
// statfs/stat only: this runs on a poll from every connected desktop and must stay cheap.
import { stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OrcadDiskUsageResult, OrcadDiskVolumeUsage } from '../../shared/orcad-disk-usage'

export type DiskUsageFs = {
  statfs: (
    path: string
  ) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>
  /** Only `dev` is read, to fold paths on one filesystem into one volume. */
  stat: (path: string) => Promise<{ dev: number }>
}

const nodeFs: DiskUsageFs = {
  statfs: (path) => statfs(path),
  stat: (path) => stat(path)
}

// Why a cap: repo lists can be long and repos almost always share the workspace filesystem.
const MAX_PROBED_PATHS = 16

/** The path itself, else its nearest existing ancestor (a configured workspace dir may not exist yet). */
async function existingAncestor(fs: DiskUsageFs, path: string): Promise<string | null> {
  let current = path
  for (;;) {
    try {
      await fs.stat(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return null
      }
      current = parent
    }
  }
}

function toVolume(
  path: string,
  stats: { bsize: number; blocks: number; bfree: number; bavail: number }
): OrcadDiskVolumeUsage {
  const totalBytes = stats.blocks * stats.bsize
  const freeBytes = stats.bfree * stats.bsize
  const availableBytes = stats.bavail * stats.bsize
  // df's Use%: used over (used + available), so root-reserved blocks don't read as free.
  const used = Math.max(0, totalBytes - freeBytes)
  const denominator = used + availableBytes
  const usedPercent = denominator > 0 ? Math.min(100, (used / denominator) * 100) : 0
  return { path, totalBytes, freeBytes, availableBytes, usedPercent }
}

/** `paths` in priority order (workspace root first); unreadable paths are skipped, not fatal. */
export async function readOrcadDiskUsage(
  paths: readonly (string | null | undefined)[],
  options: { fs?: DiskUsageFs; now?: () => number } = {}
): Promise<OrcadDiskUsageResult> {
  const fs = options.fs ?? nodeFs
  const seenPaths = new Set<string>()
  const seenDevices = new Set<number>()
  const volumes: OrcadDiskVolumeUsage[] = []
  for (const candidate of paths) {
    if (!candidate || seenPaths.has(candidate) || seenPaths.size >= MAX_PROBED_PATHS) {
      continue
    }
    seenPaths.add(candidate)
    try {
      const path = await existingAncestor(fs, candidate)
      if (!path) {
        continue
      }
      const { dev } = await fs.stat(path)
      if (seenDevices.has(dev)) {
        continue
      }
      seenDevices.add(dev)
      volumes.push(toVolume(path, await fs.statfs(path)))
    } catch {
      // A path that vanished or denies access says nothing about free space elsewhere.
    }
  }
  return { volumes, checkedAt: (options.now ?? Date.now)() }
}
