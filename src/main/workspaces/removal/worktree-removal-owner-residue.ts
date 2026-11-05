import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { collectWorkspaceSessionWorktreeOwners } from '../../persistence/restoring-sessions/session-worktree-ownership'
import type { RuntimeStore } from '../../runtime/runtime-store-contract'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import type { Repo } from '../../../shared/repo-types'

export type OwnerResidueStore = Partial<
  Pick<
    RuntimeStore,
    | 'getAllWorktreeMeta'
    | 'getAllWorktreeMetaForHost'
    | 'readWorkspaceSurfaces'
    | 'workspaceSurfacesInitialized'
    | 'getWorkspaceSession'
  >
> & {
  getRepos(): readonly (Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> & { path?: string })[]
}

/** A missing checkout cannot finish an accepted removal while its local logical owner remains. */
export function hasLocalWorktreeRemovalOwner(
  store: OwnerResidueStore,
  record: WorktreeRemovalRecord
): boolean {
  return localWorktreeRemovalOwners(store, [record]).has(record.worktreeId)
}

/** Called after filesystem probes so each decision uses one current, synchronous owner read. */
export function localWorktreeRemovalOwners(
  store: OwnerResidueStore,
  records: readonly WorktreeRemovalRecord[]
): ReadonlySet<string> {
  const retained = new Set<string>()
  if (!records.length) {
    return retained
  }
  const repos = new Map<string, ReturnType<OwnerResidueStore['getRepos']>[number][]>()
  for (const repo of store.getRepos()) {
    const owners = repos.get(repo.id) ?? []
    owners.push(repo)
    repos.set(repo.id, owners)
  }
  const holders = new Set(
    store
      .readWorkspaceSurfaces?.('local')
      .filter((surface) => surface.content !== null)
      .map((surface) => surface.workspaceId)
  )
  const metadata = store.getAllWorktreeMetaForHost?.('local') ?? store.getAllWorktreeMeta?.() ?? {}
  const session = !store.workspaceSurfacesInitialized?.('local')
    ? store.getWorkspaceSession?.('local')
    : undefined
  const legacy = session
    ? collectWorkspaceSessionWorktreeOwners(
        session,
        new Set(records.map((record) => record.worktreeId))
      )
    : new Set<string>()
  for (const record of records) {
    const owners = repos.get(record.repoId) ?? []
    if (
      !owners.some(
        (repo) =>
          getRepoExecutionHostId(repo) === 'local' &&
          repo.path !== undefined &&
          areWorktreePathsEqual(repo.path, record.repoPath)
      )
    ) {
      continue
    }
    const meta = metadata[record.worktreeId]
    if (
      holders.has(record.worktreeId) ||
      legacy.has(record.worktreeId) ||
      (meta && (meta.hostId === 'local' || (!meta.hostId && owners.length === 1)))
    ) {
      retained.add(record.worktreeId)
    }
  }
  return retained
}
