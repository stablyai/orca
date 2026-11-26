import { mkdir, realpath, rmdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** The two mkdir locks Claude Code takes while it refreshes a folder's login. */
export async function claudeRefreshLockPaths(home: string): Promise<string[]> {
  return [join(home, '.oauth_refresh.lock'), `${await realpathOrSelf(home)}.lock`]
}

export async function claudeFileLockPath(file: string): Promise<string> {
  return `${await realpathOrSelf(file)}.lock`
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A refresh holds the lock for seconds, and proper-lockfile holders also touch it every few
 * seconds, so a lock untouched this long was left by a holder that quit.
 */
export const ABANDONED_LOCK_MS = 5 * 60_000

/** Removes a lock left by a holder that quit. rmdir leaves a lock that holds files alone. */
async function clearAbandoned(path: string, now: number): Promise<void> {
  try {
    if (now - (await stat(path)).mtimeMs >= ABANDONED_LOCK_MS) {
      await rmdir(path)
    }
  } catch {
    // Gone already, or not a lock this can remove.
  }
}

/** Takes every lock or none; another holder's lock is removed only once abandoned. */
export class RotationDirLock {
  private held: string[] = []

  constructor(
    private readonly paths: string[],
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep
  ) {}

  async acquire(waitMs: number): Promise<boolean> {
    const end = Date.now() + waitMs
    for (;;) {
      const got: string[] = []
      for (const path of this.paths) {
        try {
          await mkdir(path)
          got.push(path)
        } catch {
          // A removed lock is taken on the next try, like any free one, so a racing taker can win.
          await clearAbandoned(path, Date.now())
          break
        }
      }
      if (got.length === this.paths.length) {
        this.held = got
        return true
      }
      for (const path of got.toReversed()) {
        await tryRemoveDir(path)
      }
      if (Date.now() >= end) {
        return false
      }
      await this.sleep(400 + Math.random() * 400)
    }
  }

  /** Lockfile readers treat an old lock as abandoned, so refresh it between writes. */
  async touch(): Promise<void> {
    const now = new Date()
    for (const path of this.held) {
      try {
        await utimes(path, now, now)
      } catch {
        // A missing lock cannot be refreshed; release still skips it.
      }
    }
  }

  async release(): Promise<void> {
    const held = this.held
    this.held = []
    for (const path of held.toReversed()) {
      await tryRemoveDir(path)
    }
  }
}

async function tryRemoveDir(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch {
    // Already gone.
  }
}
