/** List user distros from Lxss (including WSL version), then probe running state without booting any. Exclude Docker internals. */
import type { WslHostDistro } from '../../shared/wsl-host-types'
import { filterUserWslDistros } from '../wsl-distro-list-output'
import {
  readConfirmedRunningWslDistros,
  type WslRunningDistrosRead
} from '../wsl-background-distro-gate'
import { readWslDistroRegistrations, type WslDistroRegistration } from './wsl-distro-registry-id'

export type WslHostDistroListDependencies = {
  readRegistrations?: () => Promise<WslDistroRegistration[] | null>
  readRunning?: () => Promise<WslRunningDistrosRead>
}

export type WslHostDistroCandidate = Omit<WslHostDistro, 'environmentId'> & { id: string }

export async function listWslHostDistros(
  dependencies: WslHostDistroListDependencies = {}
): Promise<WslHostDistroCandidate[]> {
  const [registered, running] = await Promise.all([
    (dependencies.readRegistrations ?? readWslDistroRegistrations)(),
    (dependencies.readRunning ?? readConfirmedRunningWslDistros)().catch(
      (): WslRunningDistrosRead => ({ status: 'unavailable' })
    )
  ])
  if (!registered) {
    return []
  }
  const runningKeys =
    running.status === 'confirmed'
      ? new Set(running.distros.map((name) => name.trim().toLowerCase()))
      : null
  const userNames = new Set(filterUserWslDistros(registered.map(({ distro }) => distro)))
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
