import { runProcessSync } from '@orca/process-host'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import { toWindowsWslPath } from '../../../shared/file-access/wsl-paths'
import { filterUserWslDistros, parseWslDistros } from './wsl-distro-list-output'
import { wslDistroListRetryDelayMs } from './wsl-distro-retry'
import { dropStaleWslAvailabilityFailure } from './wsl-availability'
import {
  WSL_PROBE_TIMEOUT_MS,
  runWslExe,
  wslExeProcessSpec,
  wslExeStdout
} from '../execution/wsl-exe-process'
import {
  isWslListOutputLost,
  listedOrRegisteredWslDistros,
  readRegisteredWslDistrosLater,
  runningWhenListedNone
} from './wsl-registered-distro-fallback'
import {
  resolveRunningWslDistros,
  type RunningWslDistroReadOptions
} from './wsl-running-distro-cache'
import { getCachedWslHome, rememberWslHome } from './wsl-home-cache'
import { notifyWslDiscoveryChanged } from './wsl-discovery-change'
import {
  peekWslInstallation,
  peekWslInstallationAndRefreshIfDue,
  readWslInstallation
} from './wsl-installation'

// Measured on a slow PC: a cold systemd distro takes 4-11 s to answer its first exec, and killing
// wsl.exe mid-boot leaves the distro failing every call with Wsl/Service/E_UNEXPECTED for 14+ s.
// An async probe blocks nothing, so it waits out the boot.
const WSL_HOME_PROBE_ASYNC_TIMEOUT_MS = 60_000

function wslHomeProbeArgs(distro: string): string[] {
  return buildWslExecArgs(distro, ['bash', '-c', 'echo $HOME'])
}

const wslHomeProbeCache = new Map<string, Promise<string | null>>()

let wslDistroCache: string[] | null = null

let wslDistroListInFlight: Promise<string[]> | null = null

// Empty and failed probes stay retryable, with capped backoff to avoid repeatedly spawning wsl.exe.
let wslDistroListRetryAfterMs = 0

let wslDistroListEmptyStreak = 0

let wslDistroProbeSequence = 0

let wslDistroCacheSequence = 0

// Why: a missing WSL install never becomes a distro list. Caching the absence stops the 5-minute wsl.exe retry.
let wslInstallationAbsent = false

function rememberWslInstallationAbsent(): string[] {
  wslInstallationAbsent = true
  wslDistroCache = []
  wslDistroListRetryAfterMs = 0
  return wslDistroCache
}

function armWslDistroListRetry(): void {
  const now = Date.now()
  // Concurrent completions belong to the retry window already armed by the first result.
  if (now < wslDistroListRetryAfterMs) {
    return
  }
  wslDistroListEmptyStreak += 1
  wslDistroListRetryAfterMs = now + wslDistroListRetryDelayMs(wslDistroListEmptyStreak)
}

// Provisioning can return zero distros; retry empty answers while retaining them for missing-distro repair prompts.
function cacheWslDistroList(rawDistros: string[], probeSequence: number): string[] {
  const userDistros = filterUserWslDistros(rawDistros)
  // An older positive result must not replace the newer lifetime-stable list.
  if (
    probeSequence < wslDistroCacheSequence &&
    (userDistros.length === 0 || (wslDistroCache?.length ?? 0) > 0)
  ) {
    return wslDistroCache ?? []
  }
  // A late empty result must not erase a list found by another overlapping probe.
  if (userDistros.length === 0 && wslDistroCache !== null && wslDistroCache.length > 0) {
    return wslDistroCache
  }
  wslDistroCacheSequence = probeSequence
  const changed = wslDistroCache?.join('\0') !== userDistros.join('\0')
  wslDistroCache = userDistros
  // After the list is written, so route reconciliation never sees half-updated discovery.
  if (userDistros.length > 0) {
    dropStaleWslAvailabilityFailure()
  }
  if (changed) {
    notifyWslDiscoveryChanged()
  }
  if (wslDistroCache.length === 0) {
    armWslDistroListRetry()
  }
  return wslDistroCache
}

function shouldReuseCachedWslDistros(): boolean {
  return (
    wslDistroCache !== null && (wslDistroCache.length > 0 || Date.now() < wslDistroListRetryAfterMs)
  )
}

export function listWslDistros(): string[] {
  if (wslInstallationAbsent) {
    return wslDistroCache ?? []
  }

  if (shouldReuseCachedWslDistros()) {
    return wslDistroCache ?? []
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListRetryAfterMs) {
    return wslDistroCache ?? []
  }

  const installed = peekWslInstallationAndRefreshIfDue()
  if (installed === 'absent') {
    return rememberWslInstallationAbsent()
  }
  // No registered service key and no sc.exe verdict yet: a sync wsl.exe could open the installer.
  if (installed === null) {
    void listWslDistrosAsync()
    return wslDistroCache ?? []
  }

  try {
    const probeSequence = ++wslDistroProbeSequence
    const output = wslExeStdout(
      runProcessSync(wslExeProcessSpec(['--list', '--quiet'], WSL_PROBE_TIMEOUT_MS))
    )
    const listed = parseWslDistros(output)
    if (listed.length === 0) {
      readRegisteredWslDistrosLater((found) => cacheWslDistroList(found, probeSequence))
    }
    return cacheWslDistroList(listed, probeSequence)
  } catch {
    armWslDistroListRetry()
    return wslDistroCache ?? []
  }
}

export async function listWslDistrosAsync(): Promise<string[]> {
  if (wslInstallationAbsent) {
    return wslDistroCache ?? []
  }

  if (wslDistroCache !== null && wslDistroCache.length > 0) {
    return wslDistroCache
  }
  // Join before checking negative cache: a sync empty result can arm backoff while a newer probe is pending.
  if (wslDistroListInFlight) {
    return wslDistroListInFlight
  }

  if (shouldReuseCachedWslDistros()) {
    return wslDistroCache ?? []
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListRetryAfterMs) {
    return wslDistroCache ?? []
  }

  // Catch before sharing the promise so all concurrent callers receive the same fallback.
  const probeSequence = ++wslDistroProbeSequence
  const probe = readWslInstallation()
    .then((installed) => {
      if (installed === 'absent') {
        return rememberWslInstallationAbsent()
      }
      return runWslExe(['--list', '--quiet']).then(async (output) =>
        cacheWslDistroList(
          await listedOrRegisteredWslDistros(parseWslDistros(output)),
          probeSequence
        )
      )
    })
    .catch(() => {
      armWslDistroListRetry()
      return wslDistroCache ?? []
    })
    .finally(() => {
      // Only the probe that owns the slot may clear it; a test reset can install a newer one.
      if (wslDistroListInFlight === probe) {
        wslDistroListInFlight = null
      }
    })
  wslDistroListInFlight = probe
  return probe
}

export async function listRunningWslDistrosAsync(
  options: RunningWslDistroReadOptions = {}
): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  // The running-list failure backoff also caps at 5 minutes and would keep launching the installer.
  // A known install starts the wsl.exe probe before the first await so concurrent callers share it.
  // Confirmed absence is a confirmed empty list, even under requireConfirmed.
  if (peekWslInstallation() !== 'present' && (await readWslInstallation()) === 'absent') {
    return []
  }
  return resolveRunningWslDistros(
    () =>
      // A host known to lose redirected list output goes straight to the console.
      isWslListOutputLost()
        ? runningFromList('')
        : runWslExe(['--list', '--running', '--quiet'], {
            ...process.env,
            WSL_UTF8: '1'
          }).then(runningFromList),
    options
  )
}

// Empty means "none running" unless this host loses list output; then only a console can tell.
async function runningFromList(output: string): Promise<string[]> {
  const listed = parseWslDistros(output)
  if (listed.length > 0) {
    return filterUserWslDistros(listed)
  }
  return runningWhenListedNone(await listWslDistrosAsync(), WSL_PROBE_TIMEOUT_MS)
}

export function hasCachedWslDistros(): boolean {
  return wslDistroCache !== null
}

// Preserve stale answers for repair prompts; normal discovery refreshes them after backoff.
export function getCachedWslDistros(): string[] | null {
  return wslDistroCache
}

export function getDefaultWslDistro(): string | null {
  return listWslDistros()[0] ?? null
}

/** Cache successful distro-home probes as Windows UNC paths. */
export function getWslHome(distro: string): string | null {
  const cachedHome = getCachedWslHome(distro)
  if (cachedHome !== undefined) {
    return cachedHome
  }
  // A second, 5 s-bounded probe would kill a boot the in-flight one is waiting out.
  if (wslHomeProbeCache.has(distro)) {
    return null
  }
  // A saved distro on a host without WSL must not reach wsl.exe, before the verdict or after it.
  const installed = process.platform === 'win32' ? peekWslInstallationAndRefreshIfDue() : 'present'
  if (installed === 'absent' || installed === null) {
    return null
  }

  try {
    const home = wslExeStdout(
      runProcessSync(wslExeProcessSpec(wslHomeProbeArgs(distro), WSL_PROBE_TIMEOUT_MS))
    ).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    return rememberWslHome(distro, uncPath)
  } catch {
    return null
  }
}

/** Share asynchronous distro-home probes; only successful homes enter the lifetime cache. */
export async function getWslHomeAsync(distro: string): Promise<string | null> {
  const cachedHome = getCachedWslHome(distro)
  if (cachedHome !== undefined) {
    return cachedHome
  }
  const inflight = wslHomeProbeCache.get(distro)
  if (inflight) {
    return inflight
  }

  const probe = runWslExe(wslHomeProbeArgs(distro), undefined, WSL_HOME_PROBE_ASYNC_TIMEOUT_MS)
    .then((output) => {
      const home = output.trim()
      if (!home || !home.startsWith('/')) {
        return null
      }
      const uncPath = toWindowsWslPath(home, distro)
      return rememberWslHome(distro, uncPath)
    })
    .catch(() => null)
    .finally(() => {
      if (wslHomeProbeCache.get(distro) === probe) {
        wslHomeProbeCache.delete(distro)
      }
    })
  wslHomeProbeCache.set(distro, probe)
  return probe
}

/** UNC home roots for distros that are running at discovery time. */
export async function listRunningWslHomeDirsAsync(): Promise<string[]> {
  const homes = await Promise.all(
    (await listRunningWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
}
