import { listRunningWslDistrosAsync, listWslDistrosAsync } from './wsl'
import { onConfirmedRunningWslDistros } from './wsl-running-distro-cache'

// Why this gate exists: any `wsl.exe -d` (or `\\wsl.localhost` access) boots a stopped distro,
// costing 1-2s of VM boot, and on WSL < 3.0.1 that distro's later idle-stop wipes the VM-wide
// WSLInterop binfmt entry, breaking .exe launches in every other running distro
// (microsoft/WSL#13885). Rule: work the user did not just ask for (startup reconciliation,
// GC, quota polls) runs only in already-running distros; user-initiated work may boot.

type DeferredTask = () => unknown

const deferredTasksByDistro = new Map<string, Map<string, DeferredTask>>()
let unsubscribeObservations: (() => void) | null = null

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** Distros a fresh `wsl --list --running` (which never boots anything) confirmed. Why not the
 *  last-known-good fallback: a distro that idle-stopped since would read as running and get
 *  booted, so an unknown state reads as stopped and deferred work waits for a confirmed probe. */
export async function listConfirmedRunningWslDistros(): Promise<string[]> {
  return listRunningWslDistrosAsync({ requireConfirmed: true }).catch(() => [])
}

export type WslRunningDistrosRead =
  | { status: 'confirmed'; distros: string[] }
  | { status: 'unavailable' }

/** Like the confirmed list, but a failed probe says so: liveness must not read it as "stopped". */
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

/** Background-work check; a missing distro means the default one, as `wsl.exe` would pick. */
export async function isWslDistroRunningForBackgroundWork(
  distro: string | null | undefined
): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const target = distro?.trim() || (await listWslDistrosAsync())[0]
  return target ? isWslDistroRunning(target) : false
}

/**
 * Queue background work for a stopped distro; it runs once the distro is next seen running
 * (a confirmed running-list probe or a WSL terminal spawn). Same key replaces, so a rescan
 * cannot queue duplicates. In-memory only: callers must re-derive the work on next startup.
 */
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
