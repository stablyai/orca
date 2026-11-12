import { unsetWorktreeCreationBase } from './worktree-add'
import type { AddWorktreeOptions, SparseWorktreeCreateError } from '../worktree-operation-options'
import { removeWorktree } from '../removal/worktree-removal'

/** Removes a worktree whose `--no-checkout` add succeeded but whose materialization failed. */
export async function rollBackCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: AddWorktreeOptions,
  error: unknown
): Promise<SparseWorktreeCreateError> {
  const wrapped: SparseWorktreeCreateError =
    error instanceof Error ? (error as SparseWorktreeCreateError) : new Error(String(error))
  if (!options.checkoutExistingBranch) {
    try {
      await unsetWorktreeCreationBase(worktreePath, branch, options)
    } catch (cleanupError) {
      console.warn(
        `rollBackCreatedWorktree: failed to clear creation base for ${worktreePath}`,
        cleanupError
      )
    }
  }
  try {
    await removeWorktree(repoPath, worktreePath, true, {
      deleteBranch: !options.checkoutExistingBranch,
      // Roll back only the new branch, which has no user commits.
      forceBranchDelete: !options.checkoutExistingBranch,
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
    })
  } catch {
    wrapped.cleanupFailed = true
    wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
  }
  return wrapped
}
