import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  PACK_REFS_TIMEOUT_MS,
  PACKED_REFS_LOCK_POLL_MS
} from '../../shared/repo-ref-maintenance-policy'

// Minimum lock age before recovery considers an attributed pack abandoned.
const ABANDONED_LOCK_AGE_MS = PACK_REFS_TIMEOUT_MS

/** Beyond this a recorded pid may have been recycled, so it stops being evidence of life. */
const PID_REUSE_HORIZON_MS = 24 * 60 * 60_000

/** The ref tree is wide but shallow; this only stops a pathological walk. */
const REF_LOCK_SCAN_CEILING = 4096

/**
 * Recover locks attributed by an Orca marker only after an age and owner-liveness check.
 * Markers can outlive their locks; the age gate avoids removing a newly created foreign lock.
 * Beyond the PID-reuse horizon, the recorded PID no longer prevents packed-refs recovery.
 */
export class PackRefsLockOwnership {
  private readonly lockPath: string
  private readonly markerPath: string

  constructor(gitCommonDir: string) {
    const path = isWindowsAbsolutePathLike(gitCommonDir) ? win32 : posix
    this.lockPath = path.join(gitCommonDir, 'packed-refs.lock')
    this.markerPath = path.join(gitCommonDir, 'packed-refs.orca-owner')
  }

  async claim(now = Date.now()): Promise<PackRefsLockClaim> {
    const reclaim = await this.reclaimAbandonedLock(now)
    if (!reclaim.ok) {
      return reclaim
    }
    // Git does not clean per-ref locks stranded by an earlier process.
    await this.reclaimStrandedRefLocks(now)
    try {
      await writeFile(this.markerPath, JSON.stringify({ pid: process.pid }), 'utf-8')
    } catch {
      // Losing the marker only costs attribution on the next run, never correctness.
    }
    return { ok: true }
  }

  /** Poll the exclusive packed-refs rewrite window for the scheduler. */
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
    // Never reclaim an unattributed lock.
    const marker = await readOwnerMarker(this.markerPath)
    if (marker === null) {
      return { ok: false, reason: 'held by another process' }
    }
    if (lockAgeMs < ABANDONED_LOCK_AGE_MS) {
      // Even an attributed lock may belong to a newer writer; defer recovery.
      return { ok: false, reason: 'our own lock, not yet old enough to reclaim' }
    }
    // Beyond the reuse horizon, the recorded PID cannot reliably identify the original writer.
    if (isProcessAlive(marker.pid) && lockAgeMs < PID_REUSE_HORIZON_MS) {
      return { ok: false, reason: 'the recorded owner is still running' }
    }
    await rm(this.lockPath, { force: true }).catch(() => {})
    await rm(this.markerPath, { force: true }).catch(() => {})
    return { ok: true }
  }

  /** An old marker and dead owner permit recovery of empty per-ref locks stranded before signal cleanup registration. */
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

// Empty files are candidates for O_EXCL strands; ownership/age checks happen before scanning.
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

/** Stat rather than read the potentially large lock; ENOENT alone means absent. */
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
