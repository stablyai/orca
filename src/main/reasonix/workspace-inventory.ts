import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import {
  readAllWorktreeMetaForHost,
  type HostQualifiedWorktreeMetaStore
} from '../persistence/host-qualified-worktree-meta'

type WorkspaceInventory = Pick<
  HostQualifiedWorktreeMetaStore,
  'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost'
> & {
  getRepos: () => readonly Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>[]
  getFolderWorkspaces?: () => readonly Pick<
    FolderWorkspace,
    'folderPath' | 'connectionId' | 'executionHostId'
  >[]
}

export function reasonixHostWorkspaceRoots(store: WorkspaceInventory | null): string[] {
  if (!store) {
    return []
  }
  const repos = store
    .getRepos()
    .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
  const repoIds = new Set(repos.map((repo) => repo.id))
  const roots = new Set(repos.map((repo) => repo.path))
  for (const worktreeId of Object.keys(
    readAllWorktreeMetaForHost(store, LOCAL_EXECUTION_HOST_ID)
  )) {
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (parsed && repoIds.has(parsed.repoId)) {
      roots.add(parsed.worktreePath)
    }
  }
  for (const folder of store.getFolderWorkspaces?.() ?? []) {
    if (getRepoExecutionHostId(folder) === LOCAL_EXECUTION_HOST_ID) {
      roots.add(folder.folderPath)
    }
  }
  return [...roots]
}
