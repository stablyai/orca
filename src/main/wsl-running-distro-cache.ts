import { wslDistroListRetryDelayMs } from './wsl-distro-retry'

// Why: `listRunningWslDistrosAsync` polls on a 2s timer for as long as any WSL transcript
// tab is open (see wsl-transcript-running-observer.ts). Without a last-known-good fallback
// and backoff mirroring the full distro-list cache in wsl.ts, a persistently broken
// wsl.exe would make every WSL session vanish app-wide with no signal distinguishing
// "discovery broken" from "distro stopped", and would re-spawn wsl.exe every 2s forever.
let cache: string[] | null = null
let retryAfterMs = 0
let failureStreak = 0
type RunningDistroObservation = { distros: string[]; confirmed: boolean }
let inFlightProbe: Promise<RunningDistroObservation> | null = null

function armRetryAfterFailure(): void {
  const now = Date.now()
  // Concurrent completions belong to the retry window already armed by the first result.
  if (now < retryAfterMs) {
    return
  }
  failureStreak += 1
  retryAfterMs = now + wslDistroListRetryDelayMs(failureStreak)
}

/**
 * Runs `probe` unless another probe is already in flight (shares its result) or a prior
 * failure's retry window is still open (falls back to the last-known-good list instead).
 * A successful probe — including a genuine empty result, i.e. no distros running — is
 * authoritative and replaces the cache; only a probe *failure* (thrown/rejected) falls
 * back to the cache and arms backoff. Bounds wsl.exe spawns under both IPC fan-out and a
 * broken/degraded host.
 */
export async function resolveRunningWslDistros(
  probe: () => Promise<string[]>,
  options: { requireConfirmed?: boolean } = {}
): Promise<string[]> {
  const observation = await observeRunningWslDistros(probe)
  if (options.requireConfirmed && !observation.confirmed) {
    throw new Error('WSL running-distro discovery is unavailable. Retry when WSL is reachable.')
  }
  return observation.distros
}

function observeRunningWslDistros(
  probe: () => Promise<string[]>
): Promise<RunningDistroObservation> {
  if (inFlightProbe) {
    return inFlightProbe
  }
  if (Date.now() < retryAfterMs) {
    return Promise.resolve({ distros: cache ?? [], confirmed: false })
  }
  const result = probe()
    .then((distros) => {
      cache = distros
      retryAfterMs = 0
      failureStreak = 0
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

export function _resetRunningWslDistroCacheForTests(): void {
  cache = null
  retryAfterMs = 0
  failureStreak = 0
  inFlightProbe = null
}
