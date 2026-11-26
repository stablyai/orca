import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { isTrueEmptyWorktreeListing, listWorktreesStrict } from './worktree-listing'

/** Reject scan failures to prevent pruning valid worktrees and tabs; confirmed missing/non-repos return []. */
export async function listWorktreesStrictAllowingTrueEmpty(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    return await listWorktreesStrict(repoPath, options)
  } catch (err) {
    if (await isTrueEmptyWorktreeListing(repoPath, err)) {
      return []
    }
    throw err
  }
}
