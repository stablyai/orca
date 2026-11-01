import path from 'node:path'
import type { HostResourcesVolume } from '../../shared/host-resources'

export type HostResourceVolumePath = {
  role: 'home' | 'workspace'
  path: string
}

export type HostVolumeMeasurement = {
  role: 'home' | 'workspace'
  dev: number
  root: string
  usedBytes: number
  freeBytes: number
  totalBytes: number
}

export type HostVolumeReaders = {
  stat: (file: string) => Promise<{ dev: number | bigint }>
  statfs: (file: string) => Promise<{
    blocks: number | bigint
    bsize: number | bigint
    bavail: number | bigint
    bfree: number | bigint
  }>
}

type VolumeGroup = {
  hasHome: boolean
  hasWorkspace: boolean
  firstIndex: number
  usedBytes: number
  freeBytes: number
  totalBytes: number
}

export function dedupeHostVolumes(
  entries: readonly HostVolumeMeasurement[]
): HostResourcesVolume[] {
  const comparable = entries.filter(isSafeMeasurement)
  const groupByRoot = comparable.length > 0 && comparable.every((entry) => entry.dev === 0)
  const groups = new Map<string, VolumeGroup>()
  for (const [index, entry] of comparable.entries()) {
    const key = groupByRoot ? `root:${entry.root}` : `dev:${entry.dev}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        hasHome: entry.role === 'home',
        hasWorkspace: entry.role === 'workspace',
        firstIndex: index,
        usedBytes: entry.usedBytes,
        freeBytes: entry.freeBytes,
        totalBytes: entry.totalBytes
      })
      continue
    }
    existing.hasHome ||= entry.role === 'home'
    existing.hasWorkspace ||= entry.role === 'workspace'
  }

  return [...groups.values()]
    .sort((left, right) => {
      const leftWorkspace = mergedRole(left) === 'workspace'
      const rightWorkspace = mergedRole(right) === 'workspace'
      const rank = Number(leftWorkspace) - Number(rightWorkspace)
      return rank === 0 ? left.firstIndex - right.firstIndex : rank
    })
    .map((group) => ({
      role: mergedRole(group),
      usedBytes: group.usedBytes,
      freeBytes: group.freeBytes,
      totalBytes: group.totalBytes,
      usedPercent: usedPercent(group.usedBytes, group.totalBytes)
    }))
}

export async function readHostVolumes(
  volumePaths: readonly HostResourceVolumePath[],
  readers: HostVolumeReaders
): Promise<HostResourcesVolume[]> {
  const measurements = await Promise.all(volumePaths.map((entry) => measureVolume(entry, readers)))
  return dedupeHostVolumes(measurements.filter((entry) => entry !== null))
}

async function measureVolume(
  entry: HostResourceVolumePath,
  readers: HostVolumeReaders
): Promise<HostVolumeMeasurement | null> {
  try {
    const [fileStat, space] = await Promise.all([
      readers.stat(entry.path),
      readers.statfs(entry.path)
    ])
    const totalBytes = scaleBytes(space.blocks, space.bsize)
    const freeBytes = scaleBytes(space.bavail, space.bsize)
    // bavail is space an unprivileged caller can use; reserved blocks still count as used.
    const unreservedBytes = scaleBytes(space.bfree, space.bsize)
    const dev = deviceId(fileStat.dev)
    if (totalBytes === null || freeBytes === null || unreservedBytes === null || dev === null) {
      return null
    }
    return {
      role: entry.role,
      dev,
      root: path.parse(entry.path).root,
      usedBytes: Math.max(0, totalBytes - unreservedBytes),
      freeBytes,
      totalBytes
    }
  } catch {
    return null
  }
}

function mergedRole(group: VolumeGroup): HostResourcesVolume['role'] {
  if (group.hasHome && group.hasWorkspace) {
    return 'home-and-workspace'
  }
  return group.hasHome ? 'home' : 'workspace'
}

function isSafeMeasurement(entry: HostVolumeMeasurement): boolean {
  return isSafeByte(entry.usedBytes) && isSafeByte(entry.freeBytes) && isSafeByte(entry.totalBytes)
}

function scaleBytes(count: number | bigint, size: number | bigint): number | null {
  const blocks = Number(count)
  const bsize = Number(size)
  if (!Number.isSafeInteger(blocks) || !Number.isSafeInteger(bsize) || blocks < 0 || bsize < 0) {
    return null
  }
  const bytes = blocks * bsize
  return Number.isSafeInteger(bytes) ? bytes : null
}

function deviceId(dev: number | bigint): number | null {
  const value = Number(dev)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usedPercent(usedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0
  }
  return clampPercent((usedBytes / totalBytes) * 100)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

function isSafeByte(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
