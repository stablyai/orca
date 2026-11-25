import { getLocalWorktreePathAccess } from '../../../workspaces/removal/local-worktree-filesystem'
import { isWorktreePathMissing } from '../../../workspaces/removal/worktree-removal-safety'

export async function isAlreadyRemovedWorktreePath(
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  const access = getLocalWorktreePathAccess(localWorktreeGitOptions, worktreePath)
  return isWorktreePathMissing(worktreePath, access.statPath)
}
