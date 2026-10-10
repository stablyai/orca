import type { ExecutionHostId } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, getRepoIdFromWorktreeId } from '../shared/worktree/id'

type FolderWorkspaceMetaReader = {
  getRepos: () => Repo[]
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
}

/**
 * Why (#22712): a folder workspace instance exists only as its meta row, so a metadata write that
 * lands after its removal would mint a blank row the sidebar lists under the project name.
 */
export function isRemovedFolderWorkspaceInstance(
  store: FolderWorkspaceMetaReader,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  // Same-id owners can sit at different paths on different hosts, so match any folder owner.
  const isFolderInstance = store
    .getRepos()
    .some(
      (repo) =>
        repo.id === repoId &&
        isFolderRepo(repo) &&
        worktreeId.startsWith(`${repo.id}::${repo.path}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
    )
  if (!isFolderInstance) {
    return false
  }
  const meta =
    executionHostId && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, executionHostId)
      : store.getWorktreeMeta(worktreeId)
  return !meta
}
