import { isOriginalRepoOnCatalogHost } from '../../../../../shared/execution-host/execution-host'
import type { WorkerPlacementCatalog, PlacementCatalogSetup } from './worker-placement-catalog'

export type PlacementIneligibility =
  | 'not_ready'
  | 'no_checkout'
  | 'duplicate_repo_id'
  | 'folder'
  | 'ssh_host'
  | 'other_runtime'
  | 'unsupported_target'
export type ClassifiedPlacementSetup = {
  setup: PlacementCatalogSetup
  classification: 'usable' | 'registered_not_usable' | 'other_host'
  explicitStart: { usable: true } | { usable: false; reason: PlacementIneligibility }
  automaticPlacement: { available: false; reason: PlacementIneligibility | 'explicit_only' }
}

export function classifyWorkerPlacementCatalog(
  catalog: WorkerPlacementCatalog
): ClassifiedPlacementSetup[] {
  const repos = new Map<string, WorkerPlacementCatalog['repos'][number] | null>()
  for (const repo of catalog.repos) {
    repos.set(repo.id, repos.has(repo.id) ? null : repo)
  }
  return catalog.setups.map((setup) => {
    const repo = repos.get(setup.repoId)
    const hostReason = executionHostReason(setup.hostId, setup.executionHostId, setup.connectionId)
    const reason: PlacementIneligibility | null =
      hostReason ??
      (setup.setupState !== 'ready'
        ? 'not_ready'
        : !setup.repoId || !setup.path || repo === undefined
          ? 'no_checkout'
          : repo === null
            ? 'duplicate_repo_id'
            : !repo.path
              ? 'no_checkout'
              : setup.kind === 'folder' || repo.kind === 'folder'
                ? 'folder'
                : !isOriginalRepoOnCatalogHost(repo)
                  ? repo.executionHostId?.startsWith('runtime:')
                    ? 'other_runtime'
                    : 'ssh_host'
                  : setup.workerExecutionTarget?.kind !== 'native'
                    ? 'unsupported_target'
                    : null)
    return {
      setup,
      classification: hostReason ? 'other_host' : reason ? 'registered_not_usable' : 'usable',
      explicitStart: reason ? { usable: false, reason } : { usable: true },
      automaticPlacement: { available: false, reason: reason ?? 'explicit_only' }
    }
  })
}

function executionHostReason(
  hostId: string,
  executionHostId: string | null | undefined,
  connectionId: string | null | undefined
): 'ssh_host' | 'other_runtime' | null {
  if (connectionId || hostId.startsWith('ssh:') || executionHostId?.startsWith('ssh:')) {
    return 'ssh_host'
  }
  return hostId !== 'local' || !isOriginalRepoOnCatalogHost({ executionHostId, connectionId })
    ? 'other_runtime'
    : null
}
