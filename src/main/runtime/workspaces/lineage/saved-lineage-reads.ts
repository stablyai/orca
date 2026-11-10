import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import { RuntimeLineageError } from './runtime-lineage-error'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** Read ownership-scoped metadata without migration; validation must not adopt another host's legacy row. */
export function savedInstanceIdReader(
  store: RuntimeStore,
  hostId: ExecutionHostId | undefined
): (id: string) => string | undefined {
  if (!hostId) {
    return (id) => store.getWorktreeMeta(id)?.instanceId
  }
  const repos = store.getRepos()
  const ownerCounts = new Map<string, number>()
  for (const repo of repos) {
    ownerCounts.set(repo.id, (ownerCounts.get(repo.id) ?? 0) + 1)
  }
  const reposOnHost = new Map(
    repos.filter((repo) => getRepoExecutionHostId(repo) === hostId).map((repo) => [repo.id, repo])
  )
  const metaById = readAllWorktreeMetaForHost(store, hostId)
  return (id) => {
    const repo = reposOnHost.get(getRepoIdFromWorktreeId(id))
    return repo
      ? getRepoOwnedWorktreeMeta(repo, id, metaById, ownerCounts.get(repo.id) ?? 0)?.instanceId
      : undefined
  }
}

export function validateSavedLineageParentCycle(
  store: RuntimeStore | null,
  child: ResolvedWorktree,
  parent: ResolvedWorktree
): void {
  let readSavedInstanceId: ((id: string) => string | undefined) | undefined
  // Reparent invalidates the resolved cache; saved metadata must cover intermediate nodes or longer loops escape detection.
  const instanceIdOf = (id: string): string | undefined => {
    if (id === child.id || id === parent.id) {
      return id === child.id ? child.instanceId : parent.instanceId
    }
    readSavedInstanceId ??= store
      ? savedInstanceIdReader(store, child.hostId ?? parent.hostId)
      : () => undefined
    return readSavedInstanceId(id)
  }
  let cursor: string | undefined = parent.id
  const visited = new Set<string>()
  while (cursor) {
    if (cursor === child.id) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CYCLE',
        'Parent selector would create a lineage cycle.'
      )
    }
    // An unrelated saved loop must not block this parent.
    if (visited.has(cursor)) {
      break
    }
    visited.add(cursor)
    const lineage = store?.getWorktreeLineage?.(cursor)
    if (!lineage) {
      break
    }
    if (
      instanceIdOf(cursor) !== lineage.worktreeInstanceId ||
      instanceIdOf(lineage.parentWorktreeId) !== lineage.parentWorktreeInstanceId
    ) {
      break
    }
    cursor = lineage.parentWorktreeId
  }
}
