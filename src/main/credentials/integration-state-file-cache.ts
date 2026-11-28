import { stat } from 'node:fs/promises'
import { fileStatSignature } from '../filesystem/file-stat-signature'

export type IntegrationStateFileCache<T> = {
  get(): Promise<T>
  invalidate(): void
}

async function readStamp(path: string): Promise<string | null> {
  try {
    return fileStatSignature(await stat(path, { bigint: true }))
  } catch {
    return null
  }
}

export function createIntegrationStateFileCache<T>(args: {
  filePath: () => string
  readFromDisk: () => T | Promise<T>
}): IntegrationStateFileCache<T> {
  let cached: { path: string; stamp: string | null; value: T } | null = null
  // Concurrent misses that saw the same file share one read instead of each reading it.
  let pending: { path: string; stamp: string | null; revision: number; value: Promise<T> } | null =
    null
  let revision = 0
  return {
    async get(): Promise<T> {
      const reading = revision
      const path = args.filePath()
      // A write during the read leaves an older stamp and forces the next read to retry.
      const stamp = await readStamp(path)
      if (cached && cached.path === path && cached.stamp === stamp) {
        return cached.value
      }
      let read = pending
      if (!read || read.path !== path || read.stamp !== stamp || read.revision !== reading) {
        const started = {
          path,
          stamp,
          revision: reading,
          value: (async () => args.readFromDisk())()
        }
        const settle = (): void => {
          if (pending === started) {
            pending = null
          }
        }
        started.value.then(settle, settle)
        pending = read = started
      }
      const value = await read.value
      if (revision !== reading) {
        return this.get()
      }
      cached = { path, stamp, value }
      return value
    },
    invalidate(): void {
      // A concurrent writer may replace our write before we can stamp it.
      revision++
      cached = null
    }
  }
}
