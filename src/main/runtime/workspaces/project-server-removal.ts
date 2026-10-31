import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'
import type { WorkspaceServerProcessManager } from '../../servers/workspace-server-process-manager'
import { getStoredRepoExecutionHostId } from '../../repo-execution-host'

/** Runtime-stamped rows can address files registered here; an actual local sibling owns its own runs. */
export function projectServersRunHere(repo: Repo, store: RuntimeStore): boolean {
  if (getStoredRepoExecutionHostId(repo) !== 'local') {
    return false
  }
  return !store
    .getRepos()
    .some(
      (row) =>
        row.id === repo.id &&
        getRepoExecutionHostId(row) !== getRepoExecutionHostId(repo) &&
        parseExecutionHostId(getRepoExecutionHostId(row))?.kind !== 'runtime' &&
        getStoredRepoExecutionHostId(row) === 'local'
    )
}

export async function withProjectServerRemoval<T>(
  manager: WorkspaceServerProcessManager | undefined,
  repo: Repo,
  store: RuntimeStore,
  remove: () => Promise<T>
): Promise<T> {
  if (!manager || !projectServersRunHere(repo, store)) {
    return await remove()
  }
  const release = manager.beginProjectRemoval(repo.id)
  try {
    await manager.stopProject(repo.id)
    return await remove()
  } finally {
    release()
  }
}
