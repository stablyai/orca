// Why: rename() is atomic for readers but not durable. Without fsync on the file and its directory,
// a power loss after a successful rename can leave the old contents, or an empty inode — the same
// empty-file symptom as issue #1158, from a different cause. The .bak ring recovers it at up to an
// hour's loss; fsync stops it from happening.

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * fsync a directory so a rename within it is durable. Best-effort by design: Windows cannot open a
 * directory for fsync, and some filesystems reject it. The file fsync above it is the load-bearing
 * part; this closes the "rename recorded but not persisted" window where the platform allows it.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Expected on Windows and on filesystems without directory fsync.
  } finally {
    await handle?.close().catch(() => {})
  }
}

function syncDirectorySync(directory: string): void {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Same platform caveats as syncDirectory.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable; the fsync already happened or the open failed.
      }
    }
  }
}

/**
 * Rename and then fsync the containing directory. For callers that already fsynced the temp file
 * themselves and need the rename made durable.
 */
export async function renameDurable(tmpPath: string, finalPath: string): Promise<void> {
  await rename(tmpPath, finalPath)
  await syncDirectory(dirname(finalPath))
}

/** Write `payload` to `tmpPath`, fsync it, then rename onto `finalPath` and fsync the directory. */
export async function writeFileDurable(
  tmpPath: string,
  finalPath: string,
  payload: string
): Promise<void> {
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(payload, 'utf-8')
    // Why: fsync BEFORE rename. A rename that lands first can expose a zero-length file.
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmpPath, finalPath)
  await syncDirectory(dirname(finalPath))
}

/** Synchronous counterpart for quit and crash paths that cannot await. */
export function writeFileDurableSync(tmpPath: string, finalPath: string, payload: string): void {
  writeFileSync(tmpPath, payload, 'utf-8')
  const fd = openSync(tmpPath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
  syncDirectorySync(dirname(finalPath))
}
