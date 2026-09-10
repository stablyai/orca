import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
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
    // Why: `worktree add --no-checkout` writes no files, so these are the calls that
    // actually materialize the deep path and need the long-path escape hatch.
    const longPathArgs = windowsLongPathGitArgs(worktreePath)
    await gitExecFileAsync(
      ['sparse-checkout', 'init', '--cone'],
      gitExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      [...longPathArgs, 'sparse-checkout', 'set', '--', ...directories],
      gitExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      [...longPathArgs, 'checkout', branch],
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
          // Why: failed-creation rollback — the fresh branch has no user commits, so force-delete rather than orphan it.
          forceBranchDelete: !options.checkoutExistingBranch,
          ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
        })
      } catch {
        wrapped.cleanupFailed = true
        // Why: surface that manual cleanup may be needed, else a half-created worktree lingers silently on disk.
        wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
      }
    }
    throw wrapped
  }
}
