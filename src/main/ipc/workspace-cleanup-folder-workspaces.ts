import type { Store } from '../persistence'
import { createFolderWorktree } from '../repo-worktrees'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { mergeWorktree } from './worktree-logic'

export function listWorkspaceCleanupFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  const rootId = `${repo.id}::${repo.path}`
  const instancePrefix = `${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  const allMeta = store.getAllWorktreeMeta()
  const worktreeIds = [
    rootId,
    ...Object.keys(allMeta).filter((worktreeId) => worktreeId.startsWith(instancePrefix))
  ]
  const folderWorktree = createFolderWorktree(repo)

  return worktreeIds.map((worktreeId) => ({
    ...mergeWorktree(repo.id, folderWorktree, store.getWorktreeMeta(worktreeId), repo.displayName),
    id: worktreeId,
    isMainWorktree: worktreeId === rootId
  }))
}
