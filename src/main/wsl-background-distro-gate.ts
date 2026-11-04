import { listRunningWslDistrosAsync, listWslDistrosAsync } from './wsl'
import { outsideWslUserAct } from './wsl/wsl-user-act-scope'
import {
  onConfirmedRunningWslDistros,
  onRunningWslDistrosStopped,
  peekConfirmedRunningWslDistros,
  peekConfirmedRunningWslDistrosObservation
} from './wsl-running-distro-cache'

// Background work must not boot stopped distros: old WSL idle-stop can erase VM-wide WSLInterop (microsoft/WSL#13885).

type DeferredTask = () => unknown

const deferredTasksByDistro = new Map<string, Map<string, DeferredTask>>()
let unsubscribeObservations: (() => void) | null = null
// Right after a stop WSL can still list the distro; a running read started inside this window never counts.
// Same window as the orcad liveness EXIT_SETTLE_MS; not imported, to keep this module's graph small.
export const WSL_STOP_SETTLE_MS = 500
const mayHaveStoppedAt = new Map<string, number>()
const wokenAt = new Map<string, number>()
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

export type WslDistroGateNote = { kind: 'stopped' | 'woken'; distro: string }
const noteListeners = new Set<(note: WslDistroGateNote) => void>()

function ensureStopSubscription(): void {
  unsubscribeStops ??= onRunningWslDistrosStopped((stopped) => {
    for (const candidate of stopped) {
      noteWslDistroMayHaveStopped(candidate)
    }
  })
}

/** Stop and wake notes, for a utility process (the session scanner) whose own gate never hears them. */
export function onWslDistroGateNote(listener: (note: WslDistroGateNote) => void): () => void {
  ensureStopSubscription()
  noteListeners.add(listener)
  return () => noteListeners.delete(listener)
}

/** A link into the distro died, or a read saw it stop: later running reads must start after it settles. */
export function noteWslDistroMayHaveStopped(distro: string): void {
  mayHaveStoppedAt.set(distroKey(distro), performance.now())
  for (const listener of noteListeners) {
    listener({ kind: 'stopped', distro })
  }
}

/** A user act just touched the distro, which starts it: an older 'stopped' read no longer answers. */
export function noteWslDistroWoken(distro: string): void {
  wokenAt.set(distroKey(distro), performance.now())
  for (const listener of noteListeners) {
    listener({ kind: 'woken', distro })
  }
}

/** A wsl.exe launch starts its distro: if the last read said stopped, that read no longer answers. */
export function noteWslDistroLaunched(distro: string): void {
  const running = peekConfirmedRunningWslDistros()
  if (running && !running.some((candidate) => distroKey(candidate) === distroKey(distro))) {
    noteWslDistroWoken(distro)
  }
}

// The earliest start a read may have to count as running: after any stop's settle, or a wake.
function settledRunningFloor(distro: string): number {
  const stoppedAt = mayHaveStoppedAt.get(distroKey(distro))
  const woken = wokenAt.get(distroKey(distro))
  return Math.max(
    stoppedAt === undefined ? -Infinity : stoppedAt + WSL_STOP_SETTLE_MS,
    woken ?? -Infinity
  )
}

/**
 * The earliest start a running read may have: after `startedAfter` and any stop's settle window.
 * Waits until that moment has passed, so a probe started on return qualifies.
 */
export async function settledWslRunningReadAnchor(
  distro: string,
  startedAfter: number | undefined
): Promise<number | undefined> {
  ensureStopSubscription()
  const floor = settledRunningFloor(distro)
  const anchor = floor === -Infinity ? startedAfter : Math.max(startedAfter ?? -Infinity, floor)
  // Timers truncate to whole ms on a ms clock and can wake ~2ms short; sleep until the anchor has passed.
  const settled = anchor ?? -Infinity
  while (performance.now() < settled) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(settled - performance.now())))
  }
  return anchor
}

/**
 * Without probing: the last confirmed list names `distro` and was probed after any stop settled.
 * `maxAgeMs` also bounds the list's age, for stops nothing reports (e.g. WSL's own idle stop).
 */
export function wasWslDistroLastSeenRunningSettled(
  distro: string,
  options: { maxAgeMs?: number } = {}
): boolean {
  const observation = peekConfirmedRunningWslDistrosObservation()
  return (
    observation !== null &&
    observation.probeStartedAt >= settledRunningFloor(distro) &&
    (options.maxAgeMs === undefined ||
      performance.now() - observation.probeStartedAt <= options.maxAgeMs) &&
    observation.distros.some((candidate) => distroKey(candidate) === distroKey(distro))
  )
}

/** A confirmed list from a probe started after `startedAfter` and after `distro`'s stop settled. */
export async function readSettledConfirmedRunningWslDistros(
  distro: string,
  startedAfter?: number
): Promise<WslRunningDistrosRead> {
  return readConfirmedRunningWslDistros({
    startedAfter: await settledWslRunningReadAnchor(distro, startedAfter)
  })
}

export type WslDistroRunningState = 'running' | 'stopped' | 'unverifiable'

/** A failed read is 'unverifiable', never a stop; `retryUnverifiable` re-reads once past the failure backoff. */
export async function readWslDistroRunningState(
  distro: string,
  options: { startedAfter?: number; retryUnverifiable?: boolean } = {}
): Promise<WslDistroRunningState> {
  const startedAfter = await settledWslRunningReadAnchor(distro, options.startedAfter)
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
  // A probe started inside a user act must not hand its boot allowance to the drain it causes.
  // A list probed while a distro was still stopping names it too: only a settled one may drain it.
  unsubscribeObservations ??= onConfirmedRunningWslDistros((distros, probeStartedAt) => {
    const settled = distros.filter((distro) => probeStartedAt >= settledRunningFloor(distro))
    for (const distro of distros) {
      if (!settled.includes(distro)) {
        probeAfterStopSettles(distro)
      }
    }
    outsideWslUserAct(() => noteWslDistrosRunning(settled))
  })
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

const settleProbes = new Map<string, ReturnType<typeof setTimeout>>()

/** Deferred work a mid-stop list skipped should not wait on an unrelated probe: list once more past the settle. */
function probeAfterStopSettles(distro: string): void {
  const key = distroKey(distro)
  if (!deferredTasksByDistro.get(key)?.size || settleProbes.has(key)) {
    return
  }
  const floor = settledRunningFloor(distro)
  const timer = setTimeout(
    () => {
      settleProbes.delete(key)
      void readConfirmedRunningWslDistros({ startedAfter: floor })
    },
    Math.max(Math.ceil(floor - performance.now()), 0) + 1
  )
  timer.unref?.()
  settleProbes.set(key, timer)
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
        // A drain inside a user act must not hand its boot allowance to deferred work.
        void Promise.resolve(outsideWslUserAct(task)).catch(logDeferredTaskFailure)
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
  for (const timer of settleProbes.values()) {
    clearTimeout(timer)
  }
  settleProbes.clear()
  unsubscribeObservations?.()
  unsubscribeObservations = null
  mayHaveStoppedAt.clear()
  wokenAt.clear()
  unsubscribeStops?.()
  unsubscribeStops = null
  noteListeners.clear()
}
