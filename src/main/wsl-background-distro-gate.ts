import { listRunningWslDistrosAsync, listWslDistrosAsync } from './wsl'
import {
  onConfirmedRunningWslDistros,
  onRunningWslDistrosStopped
} from './wsl-running-distro-cache'
import { EXIT_SETTLE_MS } from './wsl/wsl-orcad-liveness-evidence'

// Background work must not boot stopped distros: old WSL idle-stop can erase VM-wide WSLInterop (microsoft/WSL#13885).

type DeferredTask = () => unknown

const deferredTasksByDistro = new Map<string, Map<string, DeferredTask>>()
let unsubscribeObservations: (() => void) | null = null
// Right after a stop WSL can still list the distro; a running read started inside this window never counts.
export const WSL_STOP_SETTLE_MS = EXIT_SETTLE_MS
const mayHaveStoppedAt = new Map<string, number>()
let unsubscribeStops: (() => void) | null = null

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** Require a fresh running-list result; last-known-good fallback could boot a distro that has since stopped. */
export async function listConfirmedRunningWslDistros(
  options: { startedAfter?: number } = {}
): Promise<string[]> {
  return listRunningWslDistrosAsync({ requireConfirmed: true, ...options }).catch(() => [])
}

export type WslRunningDistrosRead =
  | { status: 'confirmed'; distros: string[] }
  | { status: 'unavailable' }

/** Preserve probe failure separately from a confirmed stopped distro. `startedAfter`: see resolveRunningWslDistros. */
export async function readConfirmedRunningWslDistros(
  options: { startedAfter?: number; bypassFailureBackoff?: boolean } = {}
): Promise<WslRunningDistrosRead> {
  try {
    return {
      status: 'confirmed',
      distros: await listRunningWslDistrosAsync({ requireConfirmed: true, ...options })
    }
  } catch {
    return { status: 'unavailable' }
  }
}

/** A link into the distro died, or a read saw it stop: later running reads must start after it settles. */
export function noteWslDistroMayHaveStopped(distro: string): void {
  mayHaveStoppedAt.set(distroKey(distro), performance.now())
}

// The earliest start a running read may have: after `startedAfter` and any stop's settle window.
async function settledStartedAfter(
  distro: string,
  startedAfter: number | undefined
): Promise<number | undefined> {
  unsubscribeStops ??= onRunningWslDistrosStopped((stopped) => {
    for (const candidate of stopped) {
      noteWslDistroMayHaveStopped(candidate)
    }
  })
  const stoppedAt = mayHaveStoppedAt.get(distroKey(distro))
  const anchor =
    stoppedAt === undefined
      ? startedAfter
      : Math.max(startedAfter ?? -Infinity, stoppedAt + WSL_STOP_SETTLE_MS)
  const waitMs = (anchor ?? -Infinity) - performance.now()
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return anchor
}

export type WslDistroRunningState = 'running' | 'stopped' | 'unverifiable'

/** A failed read is 'unverifiable', never a stop; `retryUnverifiable` re-reads once past the failure backoff. */
export async function readWslDistroRunningState(
  distro: string,
  options: { startedAfter?: number; retryUnverifiable?: boolean } = {}
): Promise<WslDistroRunningState> {
  const startedAfter = await settledStartedAfter(distro, options.startedAfter)
  let read = await readConfirmedRunningWslDistros({ startedAfter })
  if (read.status === 'unavailable' && options.retryUnverifiable) {
    read = await readConfirmedRunningWslDistros({ startedAfter, bypassFailureBackoff: true })
  }
  if (read.status === 'unavailable') {
    return 'unverifiable'
  }
  const wanted = distroKey(distro)
  return read.distros.some((candidate) => distroKey(candidate) === wanted) ? 'running' : 'stopped'
}

/** `startedAfter`: only a running-list read started after it counts, e.g. after a link died. */
export async function isWslDistroRunning(
  distro: string,
  options: { startedAfter?: number } = {}
): Promise<boolean> {
  return (await readWslDistroRunningState(distro, options)) === 'running'
}

/** Missing distro selects the default, matching wsl.exe. */
export async function isWslDistroRunningForBackgroundWork(
  distro: string | null | undefined
): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const target = distro?.trim() || (await listWslDistrosAsync())[0]
  return target ? isWslDistroRunning(target) : false
}

/** In-memory deferred work is keyed per distro; callers must rediscover it after restart. Returns a cancel. */
export function deferUntilWslDistroRunning(
  distro: string,
  key: string,
  task: DeferredTask
): () => void {
  const keyForDistro = distroKey(distro)
  if (!keyForDistro) {
    return () => {}
  }
  unsubscribeObservations ??= onConfirmedRunningWslDistros(noteWslDistrosRunning)
  let tasks = deferredTasksByDistro.get(keyForDistro)
  if (!tasks) {
    tasks = new Map()
    deferredTasksByDistro.set(keyForDistro, tasks)
  }
  tasks.set(key, task)
  return () => {
    const current = deferredTasksByDistro.get(keyForDistro)
    if (current?.get(key) === task) {
      current.delete(key)
    }
  }
}

/** Runs work deferred for these distros; callers must know they are running now. */
export function noteWslDistrosRunning(distros: readonly string[]): void {
  for (const distro of distros) {
    const keyForDistro = distroKey(distro)
    const tasks = deferredTasksByDistro.get(keyForDistro)
    if (!tasks) {
      continue
    }
    deferredTasksByDistro.delete(keyForDistro)
    for (const task of tasks.values()) {
      try {
        void Promise.resolve(task()).catch(logDeferredTaskFailure)
      } catch (error) {
        logDeferredTaskFailure(error)
      }
    }
  }
}

function logDeferredTaskFailure(error: unknown): void {
  console.warn(
    '[wsl] deferred background work failed:',
    error instanceof Error ? error.message : String(error)
  )
}

export function _resetWslBackgroundDistroGateForTests(): void {
  deferredTasksByDistro.clear()
  unsubscribeObservations?.()
  unsubscribeObservations = null
  mayHaveStoppedAt.clear()
  unsubscribeStops?.()
  unsubscribeStops = null
}
