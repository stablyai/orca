import type { Repo } from '../../../../shared/repo-types'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { isWorktreePathMissing } from '../../../worktree-removal-safety'

export async function isAlreadyRemovedWorktreePath(
  repo: Repo,
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    return isWorktreePathMissing(
      toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
      access.statPath
    )
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return false
  }
  return isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path))
}
