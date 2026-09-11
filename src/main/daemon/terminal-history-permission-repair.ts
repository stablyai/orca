// History trees written before owner-only modes were pinned landed at whatever umask applied, which on
// a default umask leaves every checkpoint.json world-readable. This is the backlog repair: one bounded
// sweep of the base dir, marker-guarded so every later launch costs one existsSync rather than a walk
// over 10k session trees. Live trees are tightened per-session in terminal-history-session-files.
//
// The marker is a regular file, so `history-reader`'s directory-only session scan already skips it.

import { existsSync, type Dirent } from 'node:fs'
import { chmod, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixFileModes
} from './daemon-private-file-modes'

const REPAIR_MARKER_NAME = '.permissions-repaired-v1'
// Bounds the one-time walk: retention keeps 10k session trees, each a handful of files.
const MAX_REPAIR_ENTRIES = 200_000
// base → session/quarantine owner → quarantined generation → files.
const MAX_REPAIR_DEPTH = 3

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch {
    // A path that cannot be tightened must not abort the rest of the sweep.
  }
}

async function tightenTree(root: string): Promise<void> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let budget = MAX_REPAIR_ENTRIES
  while (queue.length > 0 && budget > 0) {
    const current = queue.shift()
    if (!current) {
      return
    }
    await chmodQuietly(current.dir, PRIVATE_DIR_MODE)
    let entries: Dirent[]
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      budget -= 1
      if (budget <= 0) {
        return
      }
      // Dirent types come from lstat, so symlinks match neither branch and are never chased.
      const child = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < MAX_REPAIR_DEPTH) {
          queue.push({ dir: child, depth: current.depth + 1 })
        }
      } else if (entry.isFile()) {
        await chmodQuietly(child, PRIVATE_FILE_MODE)
      }
    }
  }
}

/** Resolves `true` when the sweep ran. The marker is written even if some paths resisted chmod, so a
 *  permanently unfixable file cannot make every launch re-walk the tree. */
export async function repairTerminalHistoryPermissions(basePath: string): Promise<boolean> {
  if (!supportsPosixFileModes() || !existsSync(basePath)) {
    return false
  }
  const markerPath = join(basePath, REPAIR_MARKER_NAME)
  if (existsSync(markerPath)) {
    return false
  }
  await tightenTree(basePath)
  try {
    await writeFile(markerPath, '', { mode: PRIVATE_FILE_MODE })
  } catch {
    // Marker write failed: the next launch repeats a bounded, idempotent sweep.
  }
  return true
}

/** Fire-and-forget so the daemon's startup path never waits on, or fails from, permission hardening. */
export function scheduleTerminalHistoryPermissionRepair(basePath: string): void {
  void repairTerminalHistoryPermissions(basePath).catch(() => {
    // Best-effort by construction.
  })
}
