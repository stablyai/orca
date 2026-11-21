import { getErrorCode } from '../../../git/worktrees/worktree-operation-options'
import { getPathOps } from '../../../workspaces/removal/worktree-removal-home-guard'
import {
  getLocalWorktreePathAccess,
  type LocalWorktreeFilesystemOptions
} from '../../../workspaces/removal/local-worktree-filesystem'

/** A checkout folder still on disk whose `.git` link is gone. */
export async function isCheckoutMissingGitLink(
  checkoutPath: string,
  options: LocalWorktreeFilesystemOptions
): Promise<boolean> {
  const { statPath: stat } = getLocalWorktreePathAccess(options)
  try {
    await stat(checkoutPath)
  } catch {
    // Git removes a registration whose folder is gone; other errors are Git's to report.
    return false
  }
  try {
    await stat(getPathOps(checkoutPath).join(checkoutPath, '.git'))
    return false
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
}
