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
