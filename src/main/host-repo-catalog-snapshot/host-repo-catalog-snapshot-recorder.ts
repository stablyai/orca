// Keep a WSL host's project list from the catalog answers the window already asks for; never ask the host itself.

import {
  hostRepoCatalogSnapshotFromRepoList,
  type HostRepoCatalogSnapshot
} from '../../shared/host-repo-catalog-snapshot'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  isWslHostRuntimeEnvironment,
  type OrcadDeploymentLink
} from '../../shared/runtime-environments'

export type HostRepoCatalogSnapshotStore = {
  getHostRepoCatalogSnapshots(): Record<string, HostRepoCatalogSnapshot>
  setHostRepoCatalogSnapshot(environmentId: string, snapshot: HostRepoCatalogSnapshot | null): void
}

type SavedEnvironment = { id: string; orcadDeployment?: OrcadDeploymentLink | null }

/** Paired servers and recipe VMs are out of scope: only a WSL host is routinely stopped while saved. */
export function recordHostRepoCatalogAnswer(
  store: Pick<HostRepoCatalogSnapshotStore, 'setHostRepoCatalogSnapshot'>,
  environment: SavedEnvironment,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (method !== 'repo.list' || !response.ok || !isWslHostRuntimeEnvironment(environment)) {
    return
  }
  const snapshot = hostRepoCatalogSnapshotFromRepoList(response.result)
  if (snapshot) {
    store.setHostRepoCatalogSnapshot(environment.id, snapshot)
  }
}

/** Saved snapshots of hosts still saved; a host removed outside Settings must not list again. */
export function listHostRepoCatalogSnapshots(
  store: Pick<HostRepoCatalogSnapshotStore, 'getHostRepoCatalogSnapshots'>,
  savedEnvironments: readonly SavedEnvironment[]
): Record<string, HostRepoCatalogSnapshot> {
  const saved = store.getHostRepoCatalogSnapshots()
  const result: Record<string, HostRepoCatalogSnapshot> = {}
  for (const environment of savedEnvironments) {
    const snapshot = isWslHostRuntimeEnvironment(environment)
      ? // Re-validated: the saved shape is the answer shape, and a damaged profile must not seed bad rows.
        hostRepoCatalogSnapshotFromRepoList(saved[environment.id])
      : null
    if (snapshot) {
      result[environment.id] = snapshot
    }
  }
  return result
}
