// Atomic rename is not durable; fsync the file and directory to survive power loss.

import { closeSync, fsyncSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  publishFileWithoutOverwrite,
  renameFileWithWindowsRetry,
  renameFileWithWindowsRetryAsync
} from './codex-accounts/fs-utils'

/** Persist directory changes where supported; Windows and some filesystems reject directory fsync. */
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

/** Best-effort directory fsync after synchronous publication. */
export function syncDirectoryDurablySync(directory: string): void {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync may be unsupported.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/** Rename an already-fsynced file and make the containing directory durable. */
export function renameDurableSync(tmpPath: string, finalPath: string): void {
  renameFileWithWindowsRetry(tmpPath, finalPath)
  syncDirectoryDurablySync(dirname(finalPath))
}

/** Publish an already-fsynced file without replacing a concurrently created destination. */
export function publishFileDurableSync(tmpPath: string, finalPath: string): boolean {
  if (!publishFileWithoutOverwrite(tmpPath, finalPath)) {
    return false
  }
  syncDirectoryDurablySync(dirname(finalPath))
  rmSync(tmpPath)
  return true
}

/** Callers must fsync the temp file before publishing it. */
export async function renameDurable(tmpPath: string, finalPath: string): Promise<void> {
  await renameFileWithWindowsRetryAsync(tmpPath, finalPath)
  await syncDirectory(dirname(finalPath))
}

/** Make content durable without publishing, allowing backup rotation before replacement. */
export async function writeTempFileDurable(
  tmpPath: string,
  payload: string | Uint8Array,
  mode?: number
): Promise<void> {
  const handle = await open(tmpPath, 'w', mode)
  try {
    await handle.writeFile(payload, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeFileDurable(
  tmpPath: string,
  finalPath: string,
  payload: string | Uint8Array
): Promise<void> {
  await writeFileDurableIfCurrent(tmpPath, finalPath, payload, () => true)
}

/** Veto superseded writes before rename and remove their temp files on every uncommitted path. */
export async function writeFileDurableIfCurrent(
  tmpPath: string,
  finalPath: string,
  payload: string | Uint8Array,
  isCurrent: () => boolean
): Promise<boolean> {
  let renamed = false
  try {
    // Fsync before publication so power loss cannot expose an empty file.
    await writeTempFileDurable(tmpPath, payload)
    if (!(await renameFileWithWindowsRetryAsync(tmpPath, finalPath, isCurrent))) {
      return false
    }
    renamed = true
    await syncDirectory(dirname(finalPath))
    return true
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

/** Keep this naming scheme in sync with stale-temp cleanup. */
export function durableWriteTempPath(finalPath: string, owner?: string): string {
  const ownerSuffix = owner === undefined ? '' : `.owner-${owner}`
  return `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}${ownerSuffix}.tmp`
}

/** Reclaim crashed writers’ temps; age guards protect other instances, and same-PID files need owner exit. */
export async function removeStaleDurableWriteTempFiles(
  finalPath: string,
  options: { minimumAgeMs?: number; retiredOwner?: string } = {}
): Promise<void> {
  const directory = dirname(finalPath)
  const prefix = `${basename(finalPath)}.`
  const ownPrefix = `${prefix}${process.pid}.`
  const retiredOwnerSuffix =
    options.retiredOwner === undefined ? null : `.owner-${options.retiredOwner}.tmp`
  try {
    const names = await readdir(directory)
    await Promise.all(
      names
        .filter((name) => {
          if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
            return false
          }
          // The caller must await owner exit before reclaiming its current-process files.
          return retiredOwnerSuffix === null
            ? !name.startsWith(ownPrefix)
            : name.startsWith(ownPrefix) && name.endsWith(retiredOwnerSuffix)
        })
        .map(async (name) => {
          const path = join(directory, name)
          if (options.minimumAgeMs) {
            const info = await stat(path).catch(() => null)
            if (!info || Date.now() - info.mtimeMs < options.minimumAgeMs) {
              return
            }
          }
          await rm(path, { force: true }).catch(() => {})
        })
    )
  } catch {}
}

/** Synchronous counterpart for quit and crash paths that cannot await. */
export function writeFileDurableSync(
  tmpPath: string,
  finalPath: string,
  payload: string | Uint8Array,
  /** Creation mode for a new file, e.g. 0o600 for state other users must not read. */
  mode?: number
): void {
  let renamed = false
  try {
    writeFileSync(tmpPath, payload, mode === undefined ? undefined : { mode })
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameDurableSync(tmpPath, finalPath)
    renamed = true
  } finally {
    if (!renamed) {
      rmSync(tmpPath, { force: true })
    }
  }
}
