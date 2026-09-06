import { statfs } from 'node:fs/promises'
import path from 'node:path'

// Why: a system-managed Windows pagefile — and a macOS swapfile — only grows
// into free space on its own volume, so low available commit is a REFUSED
// allocation only when that volume is full too. Linux is excluded on purpose:
// its swap is a fixed partition, a fixed-size swapfile, or zram, none of which
// grow into root-fs free space, so the number would read as headroom that
// cannot exist. The measured volume ships alongside because Windows only names
// the DEFAULT pagefile drive; a relocated pagefile lives elsewhere.

const BYTES_PER_MB = 1024 * 1024

export type SwapVolumeFreeSpace = {
  freeMB: number
  /** Which volume was measured, separator-trimmed so redaction sees no path. */
  volume: string
}

type SwapVolumeFreeSpaceReader = (
  platform: NodeJS.Platform
) => Promise<SwapVolumeFreeSpace | undefined>

function swapVolumeAnchor(platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const anchor = process.env.SystemRoot || process.env.SystemDrive
    return anchor ? path.parse(anchor).root || anchor : undefined
  }
  return platform === 'darwin' ? path.sep : undefined
}

function volumeLabel(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  return trimmed.length > 0 ? trimmed : root
}

async function statfsSwapVolumeFreeSpace(
  platform: NodeJS.Platform
): Promise<SwapVolumeFreeSpace | undefined> {
  const root = swapVolumeAnchor(platform)
  if (!root) {
    return undefined
  }
  try {
    const stats = await statfs(root)
    const bytes = Number(stats.bsize) * Number(stats.bavail)
    return Number.isFinite(bytes)
      ? { freeMB: Math.round(Math.max(0, bytes) / BYTES_PER_MB), volume: volumeLabel(root) }
      : undefined
  } catch {
    return undefined
  }
}

let swapVolumeFreeSpaceReader: SwapVolumeFreeSpaceReader = statfsSwapVolumeFreeSpace

export function setSwapVolumeFreeSpaceReaderForTest(
  reader: SwapVolumeFreeSpaceReader | null
): void {
  swapVolumeFreeSpaceReader = reader ?? statfsSwapVolumeFreeSpace
}

export function readSwapVolumeFreeSpace(
  platform: NodeJS.Platform = process.platform
): Promise<SwapVolumeFreeSpace | undefined> {
  return swapVolumeFreeSpaceReader(platform)
}
