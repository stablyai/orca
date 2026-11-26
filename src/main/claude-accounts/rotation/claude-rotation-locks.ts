import { mkdirSync, realpathSync, rmdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The two mkdir locks Claude Code takes while it refreshes a folder's login. */
export function claudeRefreshLockPaths(home: string): string[] {
  return [join(home, '.oauth_refresh.lock'), `${realpathOrSelf(home)}.lock`]
}

export function claudeFileLockPath(file: string): string {
  return `${realpathOrSelf(file)}.lock`
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
          mkdirSync(path)
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
        tryRemoveDir(path)
      }
      if (Date.now() >= end) {
        return false
      }
      await this.sleep(400 + Math.random() * 400)
    }
  }

  /** Lockfile readers treat an old lock as abandoned, so refresh it between writes. */
  touch(): void {
    const now = new Date()
    for (const path of this.held) {
      try {
        utimesSync(path, now, now)
      } catch {
        // A missing lock cannot be refreshed; release still skips it.
      }
    }
  }

  release(): void {
    for (const path of this.held.toReversed()) {
      tryRemoveDir(path)
    }
    this.held = []
  }
}

function tryRemoveDir(path: string): void {
  try {
    rmdirSync(path)
  } catch {
    // Already gone.
  }
}
