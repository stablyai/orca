import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  PACK_REFS_TIMEOUT_MS,
  PACKED_REFS_LOCK_POLL_MS
} from '../../shared/repo-ref-maintenance-policy'

/** No legitimate `pack-refs` outlives its own deadline, so an older lock is abandoned. */
const ABANDONED_LOCK_AGE_MS = PACK_REFS_TIMEOUT_MS

/** Beyond this a recorded pid may have been recycled, so it stops being evidence of life. */
const PID_REUSE_HORIZON_MS = 24 * 60 * 60_000

/** The ref tree is wide but shallow; this only stops a pathological walk. */
const REF_LOCK_SCAN_CEILING = 4096

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

  /** Refused when the lock belongs to something we cannot prove is our own wreckage. */
  async claim(now = Date.now()): Promise<PackRefsLockClaim> {
    const reclaim = await this.reclaimAbandonedLock(now)
    if (!reclaim.ok) {
      return reclaim
    }
    // Per-ref strands outlive their pack and are invisible to Git, which never
    // clears a `refs/**\/*.lock` it did not create in this process.
    await this.reclaimStrandedRefLocks(now)
    try {
      await writeFile(this.markerPath, JSON.stringify({ pid: process.pid }), 'utf-8')
    } catch {
      // Losing the marker only costs attribution on the next run, never correctness.
    }
    return { ok: true }
  }

  /**
   * Poll `packed-refs.lock` so the scheduler knows when the exclusive rewrite
   * window opens and closes. Cheap: one `stat` on a fixed path.
   */
  watchLock(report: (held: boolean) => void): { stop: () => void } {
    let stopped = false
    let last = false
    const tick = async (): Promise<void> => {
      if (stopped) {
        return
      }
      const held = (await fileAgeMs(this.lockPath, Date.now())) !== null
      if (!stopped && held !== last) {
        last = held
        report(held)
      }
    }
    const timer = setInterval(() => void tick(), PACKED_REFS_LOCK_POLL_MS)
    timer.unref?.()
    void tick()
    return {
      stop: () => {
        stopped = true
        clearInterval(timer)
      }
    }
  }

  async release(): Promise<void> {
    await rm(this.markerPath, { force: true }).catch(() => {})
  }

  private async reclaimAbandonedLock(now: number): Promise<PackRefsLockClaim> {
    const lockAgeMs = await fileAgeMs(this.lockPath, now)
    if (lockAgeMs === null) {
      return { ok: true }
    }
    // No marker means the lock is not ours to reason about, let alone remove.
    const marker = await readOwnerMarker(this.markerPath)
    if (marker === null) {
      return { ok: false, reason: 'held by another process' }
    }
    if (lockAgeMs < ABANDONED_LOCK_AGE_MS) {
      // Ours, but too young to be certain the writer is gone. Worth retrying soon.
      return { ok: false, reason: 'our own lock, not yet old enough to reclaim' }
    }
    // Past the pid-reuse horizon the pid proves nothing, and a lock this old is
    // abandoned whoever wrote it -- otherwise a recycled pid would wedge the
    // repository permanently.
    if (isProcessAlive(marker.pid) && lockAgeMs < PID_REUSE_HORIZON_MS) {
      return { ok: false, reason: 'the recorded owner is still running' }
    }
    await rm(this.lockPath, { force: true }).catch(() => {})
    await rm(this.markerPath, { force: true }).catch(() => {})
    return { ok: true }
  }

  /**
   * Clear `refs/**\/*.lock` files a dead pack of ours left behind.
   *
   * `tempfile.c` opens the lock `O_EXCL` before `activate_tempfile()` links it
   * into the list the signal handler walks, so a kill inside that window leaves
   * a 0-byte file. Afterwards `update-ref -d` and any fetch touching that ref
   * fail with `cannot lock ref ... File exists`, forever. Same three conditions
   * as the packed-refs lock, plus a size check: a live writer's lock is not empty.
   */
  private async reclaimStrandedRefLocks(now: number): Promise<void> {
    const marker = await readOwnerMarker(this.markerPath)
    if (marker === null || isProcessAlive(marker.pid)) {
      return
    }
    const markerAgeMs = await fileAgeMs(this.markerPath, now)
    if (markerAgeMs === null || markerAgeMs < ABANDONED_LOCK_AGE_MS) {
      return
    }
    const path = isWindowsAbsolutePathLike(this.markerPath) ? win32 : posix
    const pending = [path.join(path.dirname(this.markerPath), 'refs')]
    let visited = 0
    while (pending.length > 0) {
      const directory = pending.pop()
      if (directory === undefined || (visited += 1) > REF_LOCK_SCAN_CEILING) {
        return
      }
      let entries: { name: string; isDirectory: () => boolean }[]
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(full)
        } else if (entry.name.endsWith('.lock') && (await isEmptyFile(full))) {
          await rm(full, { force: true }).catch(() => {})
        }
      }
    }
  }
}

export type PackRefsLockClaim = { ok: true } | { ok: false; reason: string }

/** A strand from the `O_EXCL` window is 0 bytes; a live writer's lock is not. */
async function isEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0
  } catch {
    return false
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
