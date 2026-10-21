import { statSync } from 'node:fs'
import { fileStatSignature } from './file-stat-signature'

export type IntegrationStateFileCache<T> = {
  get(): T
  invalidate(): void
}

function readStamp(path: string): string | null {
  try {
    return fileStatSignature(statSync(path, { bigint: true }))
  } catch {
    return null
  }
}

// Every Orca process on a host reads the same integration state files.
export function createIntegrationStateFileCache<T>(args: {
  filePath: () => string
  readFromDisk: () => T
}): IntegrationStateFileCache<T> {
  let cached: { path: string; stamp: string | null; value: T } | null = null
  return {
    get(): T {
      const path = args.filePath()
      // A write during the read leaves an older stamp and forces the next read to retry.
      const stamp = readStamp(path)
      if (!cached || cached.path !== path || cached.stamp !== stamp) {
        cached = { path, stamp, value: args.readFromDisk() }
      }
      return cached.value
    },
    invalidate(): void {
      // A concurrent writer may replace our write before we can stamp it.
      cached = null
    }
  }
}
