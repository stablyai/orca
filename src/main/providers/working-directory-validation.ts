// Validates a PTY working directory before spawn, so node-pty cannot fail with
// an opaque ENOENT. Split from local-pty-utils to keep that file under its line
// cap; the async path carries the cancellation contract described below.

import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { release } from 'node:os'
import { isWslUncPath, parseWslUncPath } from '../../shared/wsl-paths'
import { wslUncDirectoryExists, wslUncDirectoryExistsAsync } from '../wsl'
import { PrioritySemaphore } from '../../shared/priority-semaphore'

const pendingWorkingDirectoryValidations = new Map<string, Promise<void>>()
// Why: a dead UNC share answers `stat` in ~21s on Windows and holds one of
// libuv's 4 default fs threads the whole time, so a handful of distinct paths on
// one unreachable server would starve every other async fs read in the daemon —
// moving the head-of-line stall off the event loop and into the thread pool.
// Matches the per-distro lane in rate-limits/auth-filesystem-operation.ts.
const MAX_CONCURRENT_UNC_VALIDATIONS = 2

type UncRouteLane = {
  readonly semaphore: PrioritySemaphore
  waiters: number
}

const uncRouteLanes = new Map<string, UncRouteLane>()

/**
 * Groups paths by the host that must answer for them, so many dead
 * subdirectories of one share share a lane. Returns null for local-disk paths,
 * which never block long enough to be worth queueing.
 */
export function uncRouteKey(cwd: string): string | null {
  if (!cwd.startsWith('\\\\')) {
    return null
  }
  const wslInfo = parseWslUncPath(cwd)
  if (wslInfo) {
    return `wsl:${wslInfo.distro.trim().toLowerCase()}`
  }
  const server = cwd.slice(2).split(/[\\/]/, 1)[0]
  return `unc:${server.toLowerCase()}`
}

async function withUncRouteLane<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const key = uncRouteKey(cwd)
  if (key === null) {
    return run()
  }
  let lane = uncRouteLanes.get(key)
  if (!lane) {
    lane = { semaphore: new PrioritySemaphore(MAX_CONCURRENT_UNC_VALIDATIONS), waiters: 0 }
    uncRouteLanes.set(key, lane)
  }
  // Counted before acquiring so a queued caller keeps the lane alive.
  lane.waiters += 1
  const release = await lane.semaphore.acquire(0)
  try {
    return await run()
  } finally {
    release()
    lane.waiters -= 1
    if (lane.waiters === 0) {
      uncRouteLanes.delete(key)
    }
  }
}

/** Thrown when the caller gave up on a probe that is still running. */
export class WorkingDirectoryValidationAbortedError extends Error {
  constructor(cwd: string) {
    super(`Working directory validation for "${cwd}" was canceled.`)
    this.name = 'WorkingDirectoryValidationAbortedError'
  }
}

/** Test seam: both maps are module-level, so an unsettled probe would leak across tests. */
export function _resetWorkingDirectoryValidationStateForTest(): void {
  pendingWorkingDirectoryValidations.clear()
  uncRouteLanes.clear()
}

export function formatLocalPtyEnvironmentDiag(extra: Record<string, string> = {}): string {
  const systemVersion =
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ||
    release()
  const parts = {
    ...extra,
    arch: process.arch,
    platform: `${process.platform} ${systemVersion}`,
    orca: process.env.ORCA_APP_VERSION?.trim() || '0.0.0-dev'
  }
  return Object.entries(parts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ')
}

function throwMissingWorkingDirectory(cwd: string): never {
  throw new Error(
    `Working directory "${cwd}" does not exist. ` +
      `It may have been deleted or is on an unmounted volume ` +
      `(${formatLocalPtyEnvironmentDiag({ cwd })}).`
  )
}

/**
 * Validate that a working directory exists and is a directory.
 * Throws a descriptive Error if not.
 */
export function validateWorkingDirectory(cwd: string): void {
  // Why: Win32 fs.statSync against the WSL 9P share (\\wsl.localhost\...) can
  // falsely report ENOENT for directories that exist on the Linux side. Ask the
  // distro itself; only fall back to the fs check when wsl.exe is inconclusive.
  if (isWslUncPath(cwd)) {
    const existsInDistro = wslUncDirectoryExists(cwd)
    if (existsInDistro === false) {
      throwMissingWorkingDirectory(cwd)
    }
    if (existsInDistro === true) {
      return
    }
  }

  if (!existsSync(cwd)) {
    throwMissingWorkingDirectory(cwd)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

/**
 * Validate a cwd without blocking the daemon's shared event loop.
 *
 * `fs.stat` takes no AbortSignal and a dead SMB/NFS mount can hang it for
 * minutes, so an aborted caller abandons the shared probe rather than
 * interrupting it: the probe stays shared for whoever is still waiting, and the
 * caller stops holding a create in flight.
 */
export function validateWorkingDirectoryAsync(
  cwd: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const key = cwd
  let validation = pendingWorkingDirectoryValidations.get(key)
  if (!validation) {
    validation = validateWorkingDirectoryUncached(cwd)
    pendingWorkingDirectoryValidations.set(key, validation)
    const started = validation
    // Why: dropped only on settle. `fs.stat` is uninterruptible, so retiring a
    // still-running probe on a timer frees no libuv thread — it only lets the
    // next caller pin a second one. Callers escape through `signal` instead, so
    // sharing one hung probe no longer strands them, and the route lane below
    // caps how many distinct paths on one dead host can block at once.
    const forget = (): void => {
      if (pendingWorkingDirectoryValidations.get(key) === started) {
        pendingWorkingDirectoryValidations.delete(key)
      }
    }
    void validation.then(forget, forget)
  }
  const signal = options.signal
  if (!signal) {
    return validation
  }
  const shared = validation
  // The shared probe outlives this caller; keep it from surfacing as unhandled.
  void shared.catch(() => {})
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new WorkingDirectoryValidationAbortedError(cwd))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function validateWorkingDirectoryUncached(cwd: string): Promise<void> {
  return withUncRouteLane(cwd, () => probeWorkingDirectory(cwd))
}

async function probeWorkingDirectory(cwd: string): Promise<void> {
  if (isWslUncPath(cwd)) {
    const existsInDistro = await wslUncDirectoryExistsAsync(cwd)
    if (existsInDistro === false) {
      throwMissingWorkingDirectory(cwd)
    }
    if (existsInDistro === true) {
      return
    }
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(cwd)
  } catch {
    // One stat avoids paying an unreachable filesystem timeout twice.
    throwMissingWorkingDirectory(cwd)
  }
  if (!stats.isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}
