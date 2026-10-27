import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  noteWslDistrosRunning,
  readWslDistroRunningState,
  type WslDistroRunningState
} from '../wsl-background-distro-gate'

export { noteWslDistroMayHaveStopped } from '../wsl-background-distro-gate'

// Any 9P touch of `\\wsl.localhost\<distro>` boots a stopped distro, so background reads ask first.
// Stops are signalled (watcher or relay exit, or a read that saw it), so a running read is trusted
// this long without one, keeping wsl.exe spawns to about one a minute.
export const WSL_UNC_RUNNING_LEASE_MS = 60_000

export class WslDistroStoppedError extends Error {
  readonly code = 'WSL_DISTRO_STOPPED'

  constructor(readonly distro: string) {
    super(`WSL distro '${distro}' is not running. Retry, or open a terminal in it, to start it.`)
    this.name = 'WslDistroStoppedError'
  }
}

export class WslDistroUnverifiableError extends Error {
  readonly code = 'WSL_DISTRO_UNVERIFIABLE'

  constructor(readonly distro: string) {
    super(
      `WSL didn't answer whether '${distro}' is running, so Orca left it alone. Retry in a moment.`
    )
    this.name = 'WslDistroUnverifiableError'
  }
}

export type BlockedWslDistro = { distro: string; state: Exclude<WslDistroRunningState, 'running'> }

/** Why a background touch of `path` must not happen now, or null when it is safe. */
export async function blockedWslDistroForPath(path: string): Promise<BlockedWslDistro | null> {
  if (process.platform !== 'win32') {
    return null
  }
  const parsed = parseWslUncPath(path)
  if (!parsed) {
    return null
  }
  const state = await readWslDistroRunningState(parsed.distro, {
    startedAfter: performance.now() - WSL_UNC_RUNNING_LEASE_MS,
    retryUnverifiable: true
  })
  return state === 'running' ? null : { distro: parsed.distro, state }
}

/**
 * Refuses a background touch of a stopped (or unverifiable) distro's UNC path. `wake` is a user act:
 * it may boot the distro, and its success proves the distro runs so work waiting on it resumes.
 */
export async function guardWslUncPathAccess<T>(
  path: string,
  access: () => Promise<T>,
  options: { wake?: boolean } = {}
): Promise<T> {
  if (options.wake) {
    const result = await access()
    const parsed = process.platform === 'win32' ? parseWslUncPath(path) : null
    if (parsed) {
      noteWslDistrosRunning([parsed.distro])
    }
    return result
  }
  await assertWslUncPathRunning(path)
  return access()
}

/** Throws when a background touch of `path` would boot its distro, or WSL can't say it won't. */
export async function assertWslUncPathRunning(path: string): Promise<void> {
  const blocked = await blockedWslDistroForPath(path)
  if (blocked?.state === 'stopped') {
    throw new WslDistroStoppedError(blocked.distro)
  }
  if (blocked) {
    throw new WslDistroUnverifiableError(blocked.distro)
  }
}
