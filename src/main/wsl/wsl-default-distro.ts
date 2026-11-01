/**
 * The distro `wsl.exe` with no `-d` lands in, named once for a user act and everyone gating inside
 * it, so a one-off registry miss can't make the act and a gate disagree on which distro it is.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { runProcess } from '@orca/process-host'
import { getCachedWslDistros, listWslDistrosAsync } from '../wsl'
import {
  lxssRegQuerySpec,
  parseDefaultWslDistroId,
  parseWslDistroRegistrations
} from './wsl-distro-registry-id'

/** WSL couldn't say which distro is the default (registry and `wsl --list` both failed). */
export const UNRESOLVED_WSL_DEFAULT = Symbol('unresolved WSL default distro')
export type WslDefaultDistro = string | null | typeof UNRESOLVED_WSL_DEFAULT

// Short: a `--set-default` counts within seconds, and checks in a burst share one reg.exe.
export const WSL_DEFAULT_DISTRO_TTL_MS = 5_000

let cached: { value: WslDefaultDistro; at: number; list: readonly string[] | null } | null = null
let inFlight: Promise<WslDefaultDistro> | null = null
const pinned = new AsyncLocalStorage<{ value: WslDefaultDistro; active: boolean }>()

async function readRegistryDefault(): Promise<{ distro: string | null } | 'unreadable'> {
  try {
    const result = await runProcess(lxssRegQuerySpec())
    if (result.code !== 0) {
      return 'unreadable'
    }
    const registrations = parseWslDistroRegistrations(result.stdout)
    if (registrations.length === 0) {
      // No distro registered: wsl.exe has nothing to start.
      return { distro: null }
    }
    const defaultId = parseDefaultWslDistroId(result.stdout)
    const match = registrations.find(({ id }) => id === defaultId)
    return match ? { distro: match.distro } : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

async function readDefault(): Promise<WslDefaultDistro> {
  const registry = await readRegistryDefault()
  if (registry !== 'unreadable') {
    return registry.distro
  }
  // Registry blocked (policy, timeout) but wsl.exe may work: `--list` names the default first.
  const listed = await listWslDistrosAsync().catch(() => [])
  return listed[0] ?? UNRESOLVED_WSL_DEFAULT
}

/** The default distro: the act's pinned answer inside one, else a short-lived shared read. */
export async function resolveWslDefaultDistro(): Promise<WslDefaultDistro> {
  const pin = pinned.getStore()
  if (pin?.active) {
    return pin.value
  }
  if (process.platform !== 'win32') {
    return null
  }
  // A changed distro list (an import, unregister or set-default seen by a list read) invalidates.
  if (
    cached &&
    performance.now() - cached.at < WSL_DEFAULT_DISTRO_TTL_MS &&
    cached.list === getCachedWslDistros()
  ) {
    return cached.value
  }
  if (!inFlight) {
    const read = readDefault()
    inFlight = read
    void read
      .then((value) => {
        // After the read: its own `--list` fallback may have refreshed the list.
        cached = { value, at: performance.now(), list: getCachedWslDistros() }
      })
      .finally(() => {
        if (inFlight === read) {
          inFlight = null
        }
      })
  }
  return inFlight
}

/** Runs `act` with the default pinned to `value`, so every gate inside names the same distro. */
export async function runWithWslDefaultDistro<T>(
  value: WslDefaultDistro,
  act: () => Promise<T>
): Promise<T> {
  const pin: { value: WslDefaultDistro; active: boolean } = { value, active: true }
  try {
    return await pinned.run(pin, act)
  } finally {
    // Timers or listeners the act left behind read the default fresh.
    pin.active = false
  }
}

export function resetWslDefaultDistroForTests(): void {
  cached = null
  inFlight = null
}
