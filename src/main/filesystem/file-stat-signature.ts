import type { BigIntStats } from 'node:fs'

type StatIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>

// Preserve full Windows file IDs and timestamps that floating-point stats can collapse.
export function fileStatSignature(stats: StatIdentity): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}
