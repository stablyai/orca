// Some WSL 3 hosts exit 0 with nothing on a redirected `wsl.exe --list` (#35509), which reads as "no distros".
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { listRunningWslDistrosViaConsole } from './wsl-console-running-distros'
import { filterUserWslDistros } from './wsl-distro-list-output'
import {
  lxssRegQuerySpec,
  parseDefaultWslDistroId,
  parseWslDistroRegistrations
} from './wsl/wsl-distro-registry-id'

/** Registered user distros, default first as `wsl --list` orders them; empty when the registry is unreadable. */
export function registeredUserWslDistros(result: Pick<ProcessResult, 'code' | 'stdout'>): string[] {
  if (result.code !== 0) {
    return []
  }
  const registrations = parseWslDistroRegistrations(result.stdout)
  const defaultId = parseDefaultWslDistroId(result.stdout)
  const ordered = [
    ...registrations.filter(({ id }) => id === defaultId),
    ...registrations.filter(({ id }) => id !== defaultId)
  ]
  return filterUserWslDistros(ordered.map(({ distro }) => distro))
}

// wsl.exe listed nothing while Lxss holds distros: this host loses its redirected list output.
let listOutputLost = false

function registeredWhenListedNone(registered: string[]): string[] {
  listOutputLost ||= registered.length > 0
  return registered
}

/** The listed distros, or when wsl.exe listed none, the registered ones. */
export async function listedOrRegisteredWslDistros(listed: string[]): Promise<string[]> {
  if (listed.length > 0) {
    return listed
  }
  try {
    return registeredWhenListedNone(registeredUserWslDistros(await runProcess(lxssRegQuerySpec())))
  } catch {
    return []
  }
}

/** For sync callers, which may not spawn on main: hands any registered distros to `found` later. */
export function readRegisteredWslDistrosLater(found: (distros: string[]) => void): void {
  void listedOrRegisteredWslDistros([]).then((distros) => {
    if (distros.length > 0) {
      found(distros)
    }
  })
}

/** Whether an empty `wsl --list` on this host may be lost output rather than an empty answer. */
export function isWslListOutputLost(): boolean {
  return listOutputLost
}

/** Running distros after an empty redirected list: none, unless this host loses output; then ask a console. */
export function runningWhenListedNone(
  registered: readonly string[],
  timeoutMs: number
): Promise<string[]> {
  return listOutputLost
    ? listRunningWslDistrosViaConsole(registered, timeoutMs)
    : Promise.resolve([])
}

export function resetWslListOutputLost(): void {
  listOutputLost = false
}
