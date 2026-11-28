import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath, rename, rmdir, stat, utimes } from 'node:fs/promises'
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

/**
 * Removes a lock left by a holder that quit. rmdir on the path could remove a fresh lock taken
 * since the check, so the lock is moved aside first and removed only if it is the one checked.
 * A lock that changed, or holds files, goes back unless the path was taken again meanwhile.
 */
async function clearAbandoned(path: string, now: number): Promise<void> {
  let seen: Stats
  try {
    seen = await stat(path)
  } catch {
    return
  }
  if (now - seen.mtimeMs < ABANDONED_LOCK_MS) {
    return
  }
  const aside = `${path}.abandoned-${randomUUID()}`
  try {
    await rename(path, aside)
  } catch {
    return
  }
  try {
    const moved = await stat(aside)
    if (moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) {
      await rmdir(aside)
      return
    }
  } catch {
    // Not empty, so not a plain lock: put it back below.
  }
  try {
    await lstat(path)
  } catch {
    await rename(aside, path).catch(() => {})
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
