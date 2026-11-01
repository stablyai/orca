import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { gitExecFileAsync } from './runner'
import { addWorktree, unsetWorktreeCreationBase } from './worktree-add'
import type {
  AddWorktreeOptions,
  AddWorktreeResult,
  SparseWorktreeCreateError
} from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'
import { removeWorktree } from './worktree-removal'

export async function addSparseWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  directories: string[],
  baseBranch?: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  let created = false
  let addResult: AddWorktreeResult = {}
  try {
    addResult = await addWorktree(
      repoPath,
      worktreePath,
      branch,
      baseBranch,
      refreshLocalBaseRef,
      true,
      options
    )
    created = true
    // --no-checkout wrote no files; these materialization steps need Windows long-path support.
    const longPathArgs = windowsLongPathGitArgs(worktreePath)
    const [checkoutWorkersArgs] = await Promise.all([
      checkoutWorkersGitArgs(worktreePath, options),
      gitExecFileAsync(['sparse-checkout', 'init', '--cone'], gitExecOptions(worktreePath, options))
    ])
    await gitExecFileAsync(
      [...longPathArgs, 'sparse-checkout', 'set', '--', ...directories],
      gitExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      [...checkoutWorkersArgs, ...longPathArgs, 'checkout', branch],
      gitExecOptions(worktreePath, options)
    )
    return addResult
  } catch (error) {
    const wrapped: SparseWorktreeCreateError =
      error instanceof Error ? (error as SparseWorktreeCreateError) : new Error(String(error))
    if (created) {
      if (!options.checkoutExistingBranch) {
        try {
          await unsetWorktreeCreationBase(worktreePath, branch, options)
        } catch (cleanupError) {
          console.warn(
            `addSparseWorktree: failed to clear creation base for ${worktreePath}`,
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
    }
    throw wrapped
  }
}
