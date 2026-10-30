import type { BigIntStats } from 'node:fs'

export function watcherDirectoryIdentity(entry: BigIntStats): string | null {
  if (!entry.isDirectory()) {
    return null
  }
  if (entry.ino !== 0n) {
    return `${entry.dev}:${entry.ino}`
  }
  // Only usable birth time can identify a root on volumes without inode IDs.
  return entry.birthtimeNs === 0n || entry.birthtimeNs === entry.ctimeNs
    ? null
    : `${entry.dev}:birth:${entry.birthtimeNs}`
}
