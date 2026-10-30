// Repair older umask-derived permissions once per tree; live writers tighten their own session files.

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
// Bound repair work across the retained session backlog.
const MAX_REPAIR_ENTRIES = 200_000
// Reach quarantined generation files without walking arbitrary depth.
const MAX_REPAIR_DEPTH = 3
// Defer disk work beyond startup, like history GC.
const REPAIR_START_DELAY_MS = 10_000
const MAX_SCHEDULED_BASE_PATHS = 512

// Deduplicate repeated history-directory access while bounding retained base paths.
const scheduledBasePaths = new Set<string>()

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch {}
}

async function tightenTree(root: string): Promise<void> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let budget = MAX_REPAIR_ENTRIES
  while (queue.length > 0 && budget > 0) {
    const current = queue.shift()
    if (!current) {
      return
    }
    // chmod changes recovery fingerprints; frozen trees are tightened by their own writers after recovery.
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
      // Dirent type checks skip symlinks rather than traversing their targets.
      const child = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < MAX_REPAIR_DEPTH) {
          queue.push({ dir: child, depth: current.depth + 1 })
        }
      } else if (entry.isFile()) {
        // A freeze may begin after this directory was queued.
        if (current.depth > 0 && isTerminalHistorySessionDirRecoveryProtected(current.dir)) {
          break
        }
        await chmodQuietly(child, PRIVATE_FILE_MODE)
      }
    }
  }
}

/** Mark even partial sweeps complete so permanently unfixable paths cannot force a walk every launch. */
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
    // A failed marker write allows a later launch to retry.
  }
  return true
}

/** Defer startup I/O and deduplicate recently scheduled paths; null means already scheduled. */
export function scheduleTerminalHistoryPermissionRepair(basePath: string): Promise<boolean> | null {
  const key = resolve(basePath)
  if (scheduledBasePaths.has(key)) {
    return null
  }
  scheduledBasePaths.add(key)
  while (scheduledBasePaths.size > MAX_SCHEDULED_BASE_PATHS) {
    const oldest = scheduledBasePaths.values().next()
    if (oldest.done) {
      break
    }
    scheduledBasePaths.delete(oldest.value)
  }
  let settle!: (repaired: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  const timer = setTimeout(() => {
    repairTerminalHistoryPermissions(key).then(settle, () => settle(false))
  }, REPAIR_START_DELAY_MS)
  // Permission repair must not keep the process alive.
  timer.unref()
  return promise
}
