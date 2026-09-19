// History trees written before owner-only modes were pinned landed at whatever umask applied, which on
// a default umask leaves every checkpoint.json world-readable. This is the backlog repair: one bounded
// sweep of the base dir, marker-guarded so every later launch costs one existsSync rather than a walk
// over 10k session trees. Live trees are tightened per-session in terminal-history-session-files.
//
// The marker is a regular file, so `history-reader`'s directory-only session scan already skips it.

import { existsSync, type Dirent } from 'node:fs'
import { chmod, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixFileModes
} from './daemon-private-file-modes'
import { isTerminalHistorySessionDirRecoveryProtected } from './terminal-history-recovery-quarantine'

const REPAIR_MARKER_NAME = '.permissions-repaired-v1'
// Bounds the one-time walk: retention keeps 10k session trees, each a handful of files.
const MAX_REPAIR_ENTRIES = 200_000
// base → session/quarantine owner → quarantined generation → files.
const MAX_REPAIR_DEPTH = 3
// Same 10s the sibling history GC waits before walking this very tree, and for the same reason:
// stay off startup-critical I/O (see scheduleHistoryGc in src/main/terminal-history-gc.ts).
const REPAIR_START_DELAY_MS = 10_000

// Per-process, keyed by base path: getDaemonHistoryDir() is the accessor every history producer
// goes through, and a single startup calls it more than once. Never cleared, so a sweep that throws
// cannot wedge a retry loop — the on-disk marker is what carries the decision across launches.
const scheduledBasePaths = new Set<string>()

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
    // Why skip: chmod moves the mode/ctime that the recovery fingerprint hashes, so sweeping a tree
    // mid-freeze fails the re-check and silently stops that pane persisting for the rest of the run.
    // Nothing is left loose — the session's own writer tightens its tree when it attaches.
    if (current.depth > 0 && isTerminalHistorySessionDirRecoveryProtected(current.dir)) {
      continue
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
        // Re-checked per file: a freeze can open while this directory is being walked.
        if (current.depth > 0 && isTerminalHistorySessionDirRecoveryProtected(current.dir)) {
          break
        }
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

/** Deferred and once per base path per process, so daemon init neither waits on permission hardening
 *  nor runs two sweeps over one tree. Resolves with the sweep's outcome, or `null` when already
 *  scheduled; callers on the startup path ignore it. */
export function scheduleTerminalHistoryPermissionRepair(basePath: string): Promise<boolean> | null {
  const key = resolve(basePath)
  if (scheduledBasePaths.has(key)) {
    return null
  }
  scheduledBasePaths.add(key)
  const { promise, resolve: settle } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => {
    repairTerminalHistoryPermissions(key).then(settle, () => settle(false))
  }, REPAIR_START_DELAY_MS)
  // Why: a pending sweep must never be the reason the process (or a test worker) stays alive.
  timer.unref()
  return promise
}
