import { mkdir, realpath, rmdir, utimes } from 'node:fs/promises'
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

/** Takes every lock or none; locks held by others are never removed. */
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
