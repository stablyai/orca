import { windowsLongPathGitArgs } from '../../../../shared/git/compatibility/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktreeDeferringLocalBaseUpdate } from './worktree-add'
import type {
  AddWorktreeOptions,
  AddWorktreeResult,
  GitWorktreeExecOptions,
  SparseWorktreeCreateError
} from '../worktree-operation-options'
import { gitExecOptions } from '../worktree-operation-options'
import { removeWorktree } from '../removal/worktree-removal'

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
    const added = await addWorktreeDeferringLocalBaseUpdate(
      repoPath,
      worktreePath,
      branch,
      baseBranch,
      refreshLocalBaseRef,
      true,
      options
    )
    addResult = added.result
    created = true
    // --no-checkout wrote no files; these materialization steps need Windows long-path support.
    const longPathArgs = windowsLongPathGitArgs(worktreePath)
    const [checkoutWorkersArgs] = await Promise.all([
      checkoutWorkersGitArgs(worktreePath, options),
      gitExecFileAsync(['sparse-checkout', 'init', '--cone'], gitExecOptions(worktreePath, options))
    ])
    await gitExecFileAsync([...longPathArgs, 'sparse-checkout', 'set', '--', ...directories], {
      ...gitExecOptions(worktreePath, options),
      admissionClass: 'checkout'
    })
    await gitExecFileAsync([...checkoutWorkersArgs, ...longPathArgs, 'checkout', branch], {
      ...gitExecOptions(worktreePath, options),
      admissionClass: 'checkout'
    })
    added.updateCheckedOutLocalBase?.()
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

async function unsetWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await gitExecFileAsync(['config', '--local', '--unset-all', `branch.${branch}.base`], {
      ...gitExecOptions(worktreePath, options)
    })
  } catch {}
}
