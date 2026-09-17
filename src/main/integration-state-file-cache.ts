import { statSync } from 'node:fs'

export type IntegrationStateFileCache<T> = {
  /** Cached value, reloaded when the backing file changed since it was read. */
  get(): T
  /** Drop the cache after writing the file, so the next read re-stamps it. */
  invalidate(): void
}

// inode + size + mtime, so an atomic replace that happens to preserve size and
// mtime still invalidates. A missing file stamps as null rather than throwing.
function readStamp(path: string): string | null {
  try {
    const stats = statSync(path)
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

// Why: ~/.orca is shared by every Orca process, so a load-once cache leaves a
// connection made in one of them invisible to the others until they restart.
export function createIntegrationStateFileCache<T>(args: {
  filePath: () => string
  readFromDisk: () => T
}): IntegrationStateFileCache<T> {
  let cached: T | null = null
  let loaded = false
  let stamp: string | null = null

  return {
    get(): T {
      // Stamping before reading is the safe order: a write landing in between
      // leaves a stamp that no longer matches, so the next read reloads. The
      // reverse order would pin fresh content under a stale stamp.
      const current = readStamp(args.filePath())
      if (!loaded || current !== stamp) {
        cached = args.readFromDisk()
        stamp = current
        loaded = true
      }
      return cached as T
    },
    invalidate(): void {
      // Why: stamping our own write instead would record whatever is on disk at
      // that instant. A concurrent writer slipping in between the write and the
      // stamp would pin our value under their stamp — permanently stale, because
      // the stamps then agree forever. Reloading costs one read after each write,
      // and writes only happen on connect, disconnect, and site selection.
      loaded = false
    }
  }
}
