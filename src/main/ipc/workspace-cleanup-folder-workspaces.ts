import type { Store } from '../persistence'
import { createFolderWorktree } from '../repo-worktrees'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { mergeWorktree } from './worktree-logic'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'

export function listWorkspaceCleanupFolderWorkspaces(
  store: Store,
  repo: Repo,
  repoOwnerCount: number
): Worktree[] {
  const rootId = `${repo.id}::${repo.path}`
  const instancePrefix = `${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  const allMeta: Readonly<Record<string, WorktreeMeta>> = store.getAllWorktreeMeta()
  const worktreeIds = [
    rootId,
    ...Object.keys(allMeta).filter(
      (worktreeId) =>
        worktreeId.startsWith(instancePrefix) &&
        getRepoOwnedWorktreeMeta(repo, worktreeId, allMeta, repoOwnerCount) !== undefined
    )
  ]
  const folderWorktree = createFolderWorktree(repo)

  return worktreeIds.map((worktreeId) => ({
    ...mergeWorktree(
      repo.id,
      folderWorktree,
      getRepoOwnedWorktreeMeta(repo, worktreeId, allMeta, repoOwnerCount),
      repo.displayName
    ),
    id: worktreeId,
    isMainWorktree: worktreeId === rootId
  }))
}
