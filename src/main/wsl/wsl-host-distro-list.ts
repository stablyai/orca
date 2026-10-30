/** List user distros from Lxss (including WSL version), then probe running state without booting any. Exclude Docker internals. */
import type { WslHostDistro } from '../../shared/wsl-host-types'
import { filterUserWslDistros } from '../wsl-distro-list-output'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { readWslDistroRegistrations, type WslDistroRegistration } from './wsl-distro-registry-id'

export type WslHostDistroListDependencies = {
  readRegistrations?: () => Promise<WslDistroRegistration[] | null>
  listRunning?: () => Promise<string[]>
}

export type WslHostDistroCandidate = Omit<WslHostDistro, 'environmentId'> & { id: string }

export async function listWslHostDistros(
  dependencies: WslHostDistroListDependencies = {}
): Promise<WslHostDistroCandidate[]> {
  const [registered, running] = await Promise.all([
    (dependencies.readRegistrations ?? readWslDistroRegistrations)(),
    (dependencies.listRunning ?? listConfirmedRunningWslDistros)()
  ])
  if (!registered) {
    return []
  }
  const runningKeys = new Set(running.map((name) => name.trim().toLowerCase()))
  const userNames = new Set(filterUserWslDistros(registered.map(({ distro }) => distro)))
  return registered
    .filter(({ distro }) => userNames.has(distro))
    .map(({ id, distro, version }) => ({
      id,
      name: distro,
      version,
      state: runningKeys.has(distro.toLowerCase()) ? ('running' as const) : ('stopped' as const)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
