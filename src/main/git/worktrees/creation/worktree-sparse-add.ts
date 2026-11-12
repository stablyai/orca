import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktree } from './worktree-add'
import { rollBackCreatedWorktree } from './worktree-create-rollback'
import type { AddWorktreeOptions, AddWorktreeResult } from '../worktree-operation-options'
import { gitExecOptions } from '../worktree-operation-options'

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
    if (created) {
      throw await rollBackCreatedWorktree(repoPath, worktreePath, branch, options, error)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}
