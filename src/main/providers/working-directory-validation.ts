import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { release } from 'node:os'
import { isWslUncPath, uncRouteKey } from '../../shared/wsl-paths'
import { wslUncDirectoryExistsAsync } from '../wsl'
import { PrioritySemaphore } from '../../shared/priority-semaphore'

const pendingWorkingDirectoryValidations = new Map<string, Promise<void>>()
// Per-route limits keep dead UNC shares from consuming the default four-thread libuv fs pool.
const MAX_CONCURRENT_UNC_VALIDATIONS = 2

type UncRouteLane = {
  readonly semaphore: PrioritySemaphore
  waiters: number
}

const uncRouteLanes = new Map<string, UncRouteLane>()

export { uncRouteKey } from '../../shared/wsl-paths'

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

/** A spawn refused because its folder is gone, as the daemon reports it back across its wire. */
export function isMissingWorkingDirectoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return (
    message.startsWith('Working directory "') &&
    (message.includes('" does not exist.') || message.endsWith('" is not a directory.'))
  )
}

function throwMissingWorkingDirectory(cwd: string): never {
  throw new Error(
    `Working directory "${cwd}" does not exist. ` +
      `It may have been deleted or is on an unmounted volume ` +
      `(${formatLocalPtyEnvironmentDiag({ cwd })}).`
  )
}

export async function validateWorkingDirectory(cwd: string, signal?: AbortSignal): Promise<void> {
  // Distro probes spawn wsl.exe; never run them synchronously on main.
  if (isWslUncPath(cwd)) {
    return validateWorkingDirectoryAsync(cwd, { signal })
  }

  if (!existsSync(cwd)) {
    throwMissingWorkingDirectory(cwd)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

/** Cancellation abandons the caller, not the shared uninterruptible filesystem probe. */
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
    // Retain until settlement: expiring a hung stat frees no thread and lets retries pin more.
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
  return waitForWorkingDirectoryValidation(validation, cwd, signal)
}

function validateWorkingDirectoryUncached(cwd: string): Promise<void> {
  return withUncRouteLane(cwd, () => probeWorkingDirectory(cwd))
}

async function probeWorkingDirectory(cwd: string): Promise<void> {
  // WSL 9P stat can falsely report ENOENT; ask the distro first, then fall back only if inconclusive.
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

type WorkingDirectoryWaiterHolder = {
  waiter: {
    signal: AbortSignal
    onAbort: () => void
    resolve: () => void
    reject: (error: unknown) => void
  } | null
}

function takeWorkingDirectoryWaiter(
  holder: WorkingDirectoryWaiterHolder
): WorkingDirectoryWaiterHolder['waiter'] {
  const waiter = holder.waiter
  holder.waiter = null
  waiter?.signal.removeEventListener('abort', waiter.onAbort)
  return waiter
}

// Keep reaction order while an abandoned caller's signal and resolver become collectible.
function observeWorkingDirectoryValidation(
  promise: Promise<void>,
  holder: WorkingDirectoryWaiterHolder
): void {
  void promise.then(
    () => takeWorkingDirectoryWaiter(holder)?.resolve(),
    (error: unknown) => takeWorkingDirectoryWaiter(holder)?.reject(error)
  )
}

function waitForWorkingDirectoryValidation(
  shared: Promise<void>,
  cwd: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const holder: WorkingDirectoryWaiterHolder = { waiter: null }
    const onAbort = (): void => {
      takeWorkingDirectoryWaiter(holder)?.reject(new WorkingDirectoryValidationAbortedError(cwd))
    }
    holder.waiter = { signal, onAbort, resolve, reject }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    observeWorkingDirectoryValidation(shared, holder)
  })
}
