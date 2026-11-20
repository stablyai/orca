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

/**
 * One hold of Codex's coordination shared by a pass's lock checks and publishes, so a pass starts
 * a helper process per hold window rather than per copy. A window lets go on its own after
 * MAX_HOLD_MS (never mid-publish), so a long read or listing never keeps Codex out. Release it
 * when the pass ends.
 */
export class LegacyCopyLockHolder {
  private hold: ThreadLockFoldersHold | null = null
  private heldFolders = ''
  private heldSince = 0
  private releasedAt = 0
  private working = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private unavailable = false

  /** `busy` when a Codex holds one of `threadIds` in the first folder, or no hold can be taken. */
  async whileUnlocked<T>(
    locksDirs: string[],
    threadIds: readonly string[],
    work: () => Promise<T>
  ): Promise<T | 'busy'> {
    const folders = locksDirs.join('\0')
    if (
      this.hold &&
      (this.heldFolders !== folders || !this.hold.stillHeld() || this.windowEnded())
    ) {
      await this.release()
    }
    if (!this.hold) {
      // A hold that couldn't be taken (a Codex starting, no helper) isn't retried this pass.
      if (this.unavailable) {
        return 'busy'
      }
      const pause = this.releasedAt + PAUSE_BETWEEN_HOLDS_MS - Date.now()
      if (this.releasedAt > 0 && pause > 0) {
        await new Promise((resolve) => setTimeout(resolve, pause))
      }
      this.hold = await holdThreadLockFolders(locksDirs)
      if (!this.hold) {
        this.unavailable = true
        return 'busy'
      }
      this.heldFolders = folders
      this.heldSince = Date.now()
      this.letGoWhenWindowEnds()
    }
    if (await hasThreadLockFile(locksDirs[0], threadIds)) {
      return 'busy'
    }
    this.working += 1
    try {
      return await work()
    } finally {
      this.working -= 1
    }
  }

  async release(): Promise<void> {
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
  }

  private windowEnded(): boolean {
    return Date.now() - this.heldSince >= MAX_HOLD_MS
  }

  private letGoWhenWindowEnds(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.working === 0 && this.windowEnded()) {
        void this.release()
      } else if (this.hold) {
        this.letGoWhenWindowEnds()
      }
    }, MAX_HOLD_MS)
    this.timer.unref?.()
  }
}

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
