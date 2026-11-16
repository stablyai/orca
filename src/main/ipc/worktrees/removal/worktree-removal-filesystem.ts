import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../../../workspaces/removal/local-worktree-filesystem'
import { isWorktreePathMissing } from '../../../workspaces/removal/worktree-removal-safety'

export async function isAlreadyRemovedWorktreePath(
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
  return isWorktreePathMissing(
    toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
    access.statPath
  )
}
