import { wslDistroListRetryDelayMs } from './wsl-distro-retry'

// Preserve last-known-good state and back off failed discovery so sessions survive a persistent wsl.exe outage.
let cache: string[] | null = null
let retryAfterMs = 0
let failureStreak = 0
type RunningDistroObservation = { distros: string[]; confirmed: boolean }
let inFlightProbe: Promise<RunningDistroObservation> | null = null
// Monotonic start of the in-flight probe, and one probe chained after it for callers it predates.
let inFlightStartedAt = 0
let chainedProbe: Promise<RunningDistroObservation> | null = null
type RunningDistroStopListener = (stopped: string[], running: string[]) => void
const stopListeners = new Set<RunningDistroStopListener>()

/** Notified when a confirmed probe no longer lists a distro the previous one did. */
export function onRunningWslDistrosStopped(listener: RunningDistroStopListener): () => void {
  stopListeners.add(listener)
  return () => stopListeners.delete(listener)
}

function notifyStopped(previous: string[] | null, running: string[]): void {
  if (!previous || stopListeners.size === 0) {
    return
  }
  const current = new Set(running.map((distro) => distro.toLowerCase()))
  const stopped = previous.filter((distro) => !current.has(distro.toLowerCase()))
  if (stopped.length === 0) {
    return
  }
  for (const listener of stopListeners) {
    try {
      listener(stopped, running)
    } catch (error) {
      console.warn('[wsl] running-distro stop listener failed', error)
    }
  }
}

const confirmedObservationListeners = new Set<(distros: readonly string[]) => void>()

/** Notified with every confirmed (successful) probe result; never with a fallback list. */
export function onConfirmedRunningWslDistros(
  listener: (distros: readonly string[]) => void
): () => void {
  confirmedObservationListeners.add(listener)
  return () => {
    confirmedObservationListeners.delete(listener)
  }
}

function notifyConfirmedObservation(distros: readonly string[]): void {
  for (const listener of confirmedObservationListeners) {
    try {
      listener(distros)
    } catch (error) {
      console.warn('[wsl] running-distro listener failed', error)
    }
  }
}

function armRetryAfterFailure(): void {
  const now = Date.now()
  // Concurrent completions belong to the retry window already armed by the first result.
  if (now < retryAfterMs) {
    return
  }
  failureStreak += 1
  retryAfterMs = now + wslDistroListRetryDelayMs(failureStreak)
}

/** Share probes; only failures use stale cache/backoff. A confirmed empty result means no running distros. */
export async function resolveRunningWslDistros(
  probe: () => Promise<string[]>,
  /** `startedAfter` (performance.now()): only a probe started later may answer, e.g. after an exit. */
  options: { requireConfirmed?: boolean; startedAfter?: number } = {}
): Promise<string[]> {
  const observation = await observeRunningWslDistros(probe, options.startedAfter)
  if (options.requireConfirmed && !observation.confirmed) {
    throw new Error('WSL running-distro discovery is unavailable. Retry when WSL is reachable.')
  }
  return observation.distros
}

function observeRunningWslDistros(
  probe: () => Promise<string[]>,
  startedAfter?: number
): Promise<RunningDistroObservation> {
  if (inFlightProbe && (startedAfter === undefined || inFlightStartedAt > startedAfter)) {
    return inFlightProbe
  }
  if (inFlightProbe) {
    // The in-flight probe predates what this caller must see: one fresh probe follows it, shared.
    chainedProbe ??= inFlightProbe.then(() => {
      chainedProbe = null
      return observeRunningWslDistros(probe)
    })
    return chainedProbe
  }
  if (Date.now() < retryAfterMs) {
    return Promise.resolve({ distros: cache ?? [], confirmed: false })
  }
  inFlightStartedAt = performance.now()
  const result = probe()
    .then((distros) => {
      const previous = cache
      cache = distros
      retryAfterMs = 0
      failureStreak = 0
      notifyStopped(previous, distros)
      notifyConfirmedObservation(distros)
      return { distros, confirmed: true }
    })
    .catch((error: unknown) => {
      armRetryAfterFailure()
      console.warn('[wsl] running-distro probe failed; falling back to last-known-good list', error)
      return { distros: cache ?? [], confirmed: false }
    })
    .finally(() => {
      if (inFlightProbe === result) {
        inFlightProbe = null
      }
    })
  inFlightProbe = result
  return result
}

/** Last confirmed running list without probing; null before any probe has succeeded. */
export function peekConfirmedRunningWslDistros(): readonly string[] | null {
  return cache
}

export function _resetRunningWslDistroCacheForTests(): void {
  cache = null
  retryAfterMs = 0
  failureStreak = 0
  inFlightProbe = null
  chainedProbe = null
}
