import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  getRepoMainWorktreeId
} from '../../../shared/worktree/id'

type FolderWorkspaceMetaReader = {
  getRepos: () => Repo[]
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
}

/** Writes after removal must not recreate a blank metadata-only workspace (#22712). */
export function isRemovedFolderWorkspaceInstance(
  store: FolderWorkspaceMetaReader,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  if (!worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return false
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  // Same-id owners can sit at different paths on different hosts, so match any folder owner.
  const isFolderInstance = store.getRepos().some((repo) => {
    if (repo.id !== repoId || !isFolderRepo(repo)) {
      return false
    }
    const rootId = getRepoMainWorktreeId(repo)
    return (
      worktreeId.length > rootId.length &&
      worktreeId.startsWith(rootId) &&
      worktreeId.startsWith(FOLDER_WORKSPACE_INSTANCE_SEPARATOR, rootId.length)
    )
  })
  if (!isFolderInstance) {
    return false
  }
  const meta =
    executionHostId && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, executionHostId)
      : store.getWorktreeMeta(worktreeId)
  return !meta
}

/** Git listings cannot show extra folder workspace ids; hiding them would purge their saved tabs. */
export function findExtraFolderWorkspaceIds(
  repo: Pick<Repo, 'id' | 'path'>,
  metaById: Record<string, WorktreeMeta>
): string[] {
  const prefix = `${getRepoMainWorktreeId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  const extraIds: string[] = []
  for (const worktreeId in metaById) {
    if (Object.hasOwn(metaById, worktreeId) && worktreeId.startsWith(prefix)) {
      extraIds.push(worktreeId)
    }
  }
  return extraIds
}
