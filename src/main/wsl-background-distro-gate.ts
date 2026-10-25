import { listRunningWslDistrosAsync, listWslDistrosAsync } from './wsl'
import { onConfirmedRunningWslDistros } from './wsl-running-distro-cache'

// Background work must not boot stopped distros: old WSL idle-stop can erase VM-wide WSLInterop (microsoft/WSL#13885).

type DeferredTask = () => unknown

const deferredTasksByDistro = new Map<string, Map<string, DeferredTask>>()
let unsubscribeObservations: (() => void) | null = null

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** Require a fresh running-list result; last-known-good fallback could boot a distro that has since stopped. */
export async function listConfirmedRunningWslDistros(): Promise<string[]> {
  return listRunningWslDistrosAsync({ requireConfirmed: true }).catch(() => [])
}

export type WslRunningDistrosRead =
  | { status: 'confirmed'; distros: string[] }
  | { status: 'unavailable' }

/** Preserve probe failure separately from a confirmed stopped distro. */
export async function readConfirmedRunningWslDistros(): Promise<WslRunningDistrosRead> {
  try {
    return {
      status: 'confirmed',
      distros: await listRunningWslDistrosAsync({ requireConfirmed: true })
    }
  } catch {
    return { status: 'unavailable' }
  }
}

export async function isWslDistroRunning(distro: string): Promise<boolean> {
  const wanted = distroKey(distro)
  const running = await listConfirmedRunningWslDistros()
  return running.some((candidate) => distroKey(candidate) === wanted)
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

/** In-memory deferred work is keyed per distro; callers must rediscover it after restart. */
export function deferUntilWslDistroRunning(distro: string, key: string, task: DeferredTask): void {
  const keyForDistro = distroKey(distro)
  if (!keyForDistro) {
    return
  }
  unsubscribeObservations ??= onConfirmedRunningWslDistros(noteWslDistrosRunning)
  let tasks = deferredTasksByDistro.get(keyForDistro)
  if (!tasks) {
    tasks = new Map()
    deferredTasksByDistro.set(keyForDistro, tasks)
  }
  tasks.set(key, task)
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
}
