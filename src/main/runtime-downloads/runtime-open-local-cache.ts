import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Opened copies only need to outlive the app that opens them; a day covers a long session.
const OPEN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function runtimeOpenLocalCacheRoot(): string {
  return join(tmpdir(), 'orca-opened-remote-files')
}

/** A fresh directory per open, so two opens of same-named files never clobber each other. */
export async function createRuntimeOpenLocalDirectory(root = runtimeOpenLocalCacheRoot()) {
  const directory = join(root, randomUUID())
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

/** Best effort: removes cached copies older than a day. Failures never block an open. */
export async function pruneRuntimeOpenLocalCache(
  root = runtimeOpenLocalCacheRoot(),
  now = Date.now(),
  maxAgeMs = OPEN_CACHE_MAX_AGE_MS
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    names.map(async (name) => {
      const path = join(root, name)
      try {
        if (now - (await stat(path)).mtimeMs > maxAgeMs) {
          await rm(path, { recursive: true, force: true })
        }
      } catch {
        // Another app instance may be pruning the same entry.
      }
    })
  )
}
