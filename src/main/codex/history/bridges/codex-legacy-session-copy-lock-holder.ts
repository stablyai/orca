import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import {
  holdThreadLockFolders,
  type ThreadLockFoldersHold
} from '../shared-store/codex-thread-writer-locks'

// Codex waits up to 30 s for coordination, trying every 50 ms: windows this short, with a pause
// between them, never make a Codex starting a writer fail.
const MAX_HOLD_MS = 250
const PAUSE_BETWEEN_HOLDS_MS = 100
const CHECK_EVERY_MS = 50
// A Codex takes coordination only for moments, so a hold that can't be taken is tried again soon.
const HOLD_ATTEMPTS = 5
const AFTER_FAILED_HOLD_MS = 1000

/**
 * The one hold of Codex's coordination this Orca process shares across a background pass and any
 * resume, so a pass starts a helper per window rather than per copy, and a resume joins or waits
 * for the window instead of being refused. A window takes no new caller after MAX_HOLD_MS and lets
 * go as soon as the callers inside it are done.
 */
class LegacyCopyLockHolder {
  private hold: ThreadLockFoldersHold | null = null
  private heldFolders = ''
  private heldSince = 0
  private releasedAt = 0
  private inside = 0
  private acquiring: Promise<void> | null = null
  private nextRelease: { promise: Promise<void>; resolve: () => void } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private unavailableUntil = 0

  /** `busy` when a Codex holds one of `threadIds` in the first folder, or no hold can be taken. */
  async whileUnlocked<T>(
    locksDirs: string[],
    threadIds: readonly string[],
    work: () => Promise<T>
  ): Promise<T | 'busy'> {
    const folders = locksDirs.join('\0')
    for (;;) {
      if (this.acquiring) {
        await this.acquiring
        continue
      }
      if (this.hold?.stillHeld() && this.heldFolders === folders && !this.windowEnded()) {
        break
      }
      if (this.hold) {
        // The window's callers finish first; it lets go when the last one does.
        await (this.inside > 0 ? this.released() : this.release())
        continue
      }
      if (Date.now() < this.unavailableUntil) {
        return 'busy'
      }
      this.acquiring = this.acquire(locksDirs, folders).finally(() => {
        this.acquiring = null
      })
      await this.acquiring
      if (!this.hold) {
        return 'busy'
      }
    }
    // Counted with no await since the check above, so the window can't let go under this caller.
    this.inside += 1
    try {
      if (await hasThreadLockFile(locksDirs[0], threadIds)) {
        return 'busy'
      }
      return this.hold?.stillHeld() ? await work() : 'busy'
    } finally {
      this.inside -= 1
      if (this.inside === 0 && (this.windowEnded() || !this.hold?.stillHeld())) {
        await this.release()
      }
    }
  }

  /** Lets go now unless a caller is inside, as a pass does when it ends. */
  async releaseIfIdle(): Promise<void> {
    if (this.inside === 0) {
      await this.release()
    }
  }

  private async acquire(locksDirs: string[], folders: string): Promise<void> {
    for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt += 1) {
      const wait =
        attempt > 0 ? CHECK_EVERY_MS : this.releasedAt + PAUSE_BETWEEN_HOLDS_MS - Date.now()
      if (wait > 0 && (attempt > 0 || this.releasedAt > 0)) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      const hold = await holdThreadLockFolders(locksDirs)
      if (hold) {
        this.hold = hold
        this.heldFolders = folders
        this.heldSince = Date.now()
        this.letGoWhenIdle()
        return
      }
    }
    this.unavailableUntil = Date.now() + AFTER_FAILED_HOLD_MS
  }

  private async release(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const hold = this.hold
    this.hold = null
    if (hold) {
      this.releasedAt = Date.now()
      await hold.release()
    }
    const waiting = this.nextRelease
    this.nextRelease = null
    waiting?.resolve()
  }

  private released(): Promise<void> {
    if (!this.nextRelease) {
      let resolve = (): void => {}
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      this.nextRelease = { promise, resolve }
    }
    return this.nextRelease.promise
  }

  private windowEnded(): boolean {
    return Date.now() - this.heldSince >= MAX_HOLD_MS
  }

  // Between callers (a long read, the listing) nothing else ends the window.
  private letGoWhenIdle(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.hold) {
        return
      }
      if (this.inside === 0 && (this.windowEnded() || !this.hold.stillHeld())) {
        void this.release()
      } else {
        this.letGoWhenIdle()
      }
    }, CHECK_EVERY_MS)
    this.timer.unref?.()
  }
}

export const legacyCopyLocks = new LegacyCopyLockHolder()

// The hold deleted every free lock when it began, so a file left now belongs to a holder.
async function hasThreadLockFile(locks: string, threadIds: readonly string[]): Promise<boolean> {
  for (const id of threadIds) {
    try {
      await lstat(join(locks, `${id}.lock`))
      return true
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return true
      }
    }
  }
  return false
}
