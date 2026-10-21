import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import { isWorktreePathMissing } from '../../../worktree-removal-safety'

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
