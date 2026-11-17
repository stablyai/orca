import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

// Opened copies only need to outlive the app that opens them; a day covers a long session.
const OPEN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

// Under userData, not the OS temp dir: Linux /tmp is shared, and another local user could pre-create
// the folder and swap the file Orca is about to open.
export function runtimeOpenLocalCacheRoot(): string {
  return join(app.getPath('userData'), 'opened-remote-files')
}

/** A fresh directory per open, so two opens of same-named files never clobber each other. */
export async function createRuntimeOpenLocalDirectory(root = runtimeOpenLocalCacheRoot()) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = join(root, randomUUID())
  // Not recursive: a fresh random name that already exists means something else made it.
  await mkdir(directory, { mode: 0o700 })
  return directory
}

/** Best effort: removes cached copies older than a day. Failures never block an open. */
export async function pruneRuntimeOpenLocalCache(
  rootOverride?: string,
  now = Date.now(),
  maxAgeMs = OPEN_CACHE_MAX_AGE_MS
): Promise<void> {
  let root: string
  let names: string[]
  try {
    // Inside the try: before app ready (or in tests) userData may not resolve.
    root = rootOverride ?? runtimeOpenLocalCacheRoot()
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
