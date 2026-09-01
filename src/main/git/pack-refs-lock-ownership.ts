import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { PACK_REFS_TIMEOUT_MS } from '../../shared/repo-ref-maintenance-policy'

/** No legitimate `pack-refs` outlives its own deadline, so an older lock is abandoned. */
const ABANDONED_LOCK_AGE_MS = PACK_REFS_TIMEOUT_MS

/** Beyond this a recorded pid may have been recycled, so it stops being evidence of life. */
const PID_REUSE_HORIZON_MS = 24 * 60 * 60_000

/**
 * Makes a `packed-refs.lock` Orca left behind attributable, and only that one.
 *
 * Git registers signal handlers that clean the lock up, but SIGKILL and power
 * loss bypass them, and Git never removes a stale `packed-refs.lock` on its own
 * -- every later ref deletion in that repository fails until someone deletes a
 * file they have never heard of. Recording our pid beside the lock lets a later
 * run recognise its own wreckage.
 *
 * Three independent conditions must all hold before anything is unlinked,
 * because deleting a lock somebody else is holding is far worse than declining
 * to pack: a marker must exist at all, the lock must be older than any
 * `pack-refs` could legitimately run for, and the recorded process must be gone.
 * A marker can outlive its lock, so age is what separates "our wreckage" from a
 * foreign lock that happened to appear afterwards.
 */
export class PackRefsLockOwnership {
  private readonly lockPath: string
  private readonly markerPath: string

  constructor(gitCommonDir: string) {
    const path = isWindowsAbsolutePathLike(gitCommonDir) ? win32 : posix
    this.lockPath = path.join(gitCommonDir, 'packed-refs.lock')
    this.markerPath = path.join(gitCommonDir, 'packed-refs.orca-owner')
  }

  /** False when the lock belongs to a live process, so packing must not proceed. */
  async claim(now = Date.now()): Promise<boolean> {
    if (!(await this.reclaimAbandonedLock(now))) {
      return false
    }
    try {
      await writeFile(this.markerPath, JSON.stringify({ pid: process.pid }), 'utf-8')
    } catch {
      // Losing the marker only costs attribution on the next run, never correctness.
    }
    return true
  }

  async release(): Promise<void> {
    await rm(this.markerPath, { force: true }).catch(() => {})
  }

  private async reclaimAbandonedLock(now: number): Promise<boolean> {
    const lockAgeMs = await fileAgeMs(this.lockPath, now)
    if (lockAgeMs === null) {
      return true
    }
    // No marker means the lock is not ours to reason about, let alone remove.
    const marker = await readOwnerMarker(this.markerPath)
    if (marker === null) {
      return false
    }
    if (lockAgeMs < ABANDONED_LOCK_AGE_MS) {
      return false
    }
    // Past the pid-reuse horizon the pid proves nothing, and a lock this old is
    // abandoned whoever wrote it -- otherwise a recycled pid would wedge the
    // repository permanently.
    if (isProcessAlive(marker.pid) && lockAgeMs < PID_REUSE_HORIZON_MS) {
      return false
    }
    await rm(this.lockPath, { force: true }).catch(() => {})
    await rm(this.markerPath, { force: true }).catch(() => {})
    return true
  }
}

async function readOwnerMarker(path: string): Promise<{ pid: number } | null> {
  try {
    const raw = (await readFile(path, 'utf-8')).slice(0, 256)
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : null
  } catch {
    return null
  }
}

/** Null when the file does not exist. Uses stat: the lock holds a whole packed-refs. */
async function fileAgeMs(path: string, now: number): Promise<number | null> {
  try {
    return Math.max(0, now - (await stat(path)).mtimeMs)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 0
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
