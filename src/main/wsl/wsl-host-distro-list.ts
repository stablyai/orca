/**
 * The distros "Add WSL distro as a host" offers: every registered one (from the Lxss registry key,
 * which also says WSL 1 vs 2 without a localized `wsl --list --verbose` parse), with whether it
 * is running from a probe that never boots one. Docker Desktop's internal distros are not hosts.
 */
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { sameWslDistro } from './wsl-host-add-admission'
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

export function toWslHostDistroList(
  candidates: readonly WslHostDistroCandidate[],
  records: readonly WslHostDeploymentRecord[]
): WslHostDistro[] {
  return candidates.map(({ id: _id, ...distro }) => ({
    ...distro,
    environmentId:
      records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
  }))
}
