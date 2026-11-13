/** List user distros from Lxss (including WSL version), then probe running state without booting any. Exclude Docker internals. */
import type { WslHostDistro } from '../../../shared/wsl-host-types'
import { filterUserWslDistros } from '../discovery/wsl-distro-list-output'
import {
  readConfirmedRunningWslDistros,
  type WslRunningDistrosRead
} from '../discovery/wsl-background-distro-gate'
import {
  readWslDistroRegistrations,
  type WslDistroRegistration
} from '../discovery/wsl-distro-registry-id'

export type WslHostDistroListDependencies = {
  readRegistrations?: () => Promise<WslDistroRegistration[] | null>
  readRunning?: () => Promise<WslRunningDistrosRead>
}

export type WslHostDistroCandidate = Omit<WslHostDistro, 'environmentId'> & { id: string }

export async function listWslHostDistros(
  dependencies: WslHostDistroListDependencies = {}
): Promise<WslHostDistroCandidate[]> {
  const registered = await (dependencies.readRegistrations ?? readWslDistroRegistrations)()
  const userNames = new Set(filterUserWslDistros((registered ?? []).map(({ distro }) => distro)))
  // Without WSL, Windows' wsl.exe stub opens the installer and a UAC prompt: never spawn it for nothing.
  if (!registered || userNames.size === 0) {
    return []
  }
  const running = await (dependencies.readRunning ?? readConfirmedRunningWslDistros)().catch(
    (): WslRunningDistrosRead => ({ status: 'unavailable' })
  )
  const runningKeys =
    running.status === 'confirmed'
      ? new Set(running.distros.map((name) => name.trim().toLowerCase()))
      : null
  return registered
    .filter(({ distro }) => userNames.has(distro))
    .map(({ id, distro, version }) => ({
      id,
      name: distro,
      version,
      state: !runningKeys
        ? ('unverifiable' as const)
        : runningKeys.has(distro.toLowerCase())
          ? ('running' as const)
          : ('stopped' as const)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
