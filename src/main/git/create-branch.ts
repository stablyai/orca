import { BranchSwitchCollisionError } from './branch-switch-target'
import { readGitCommandFailureStderr } from '../../shared/git/commands/git-command-failure-text'
import { isBranchNameValid } from '../../shared/git/branch-switch-target'
import type { GitCommitActionResult } from '../../shared/git/commands/git-commit-action'
import { withCheckoutLock } from './branch-switch'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './source-control/git-read-cache-invalidation'

export async function createBranch(
  worktreePath: string,
  name: string,
  startPoint: string,
  options: GitRuntimeOptions = {}
): Promise<GitCommitActionResult> {
  if (!isBranchNameValid(name)) {
    throw new Error('This branch name is invalid. Choose a different name.')
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(startPoint)) {
    throw new Error('Expected a full git object id')
  }
  return withCheckoutLock(worktreePath, async () => {
    const execution = gitOptionsForWorktree(worktreePath, options)
    await gitExecFileAsync(['check-ref-format', '--branch', name], execution).catch(() => {
      throw new Error('This branch name is invalid. Choose a different name.')
    })
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(['branch', '--no-track', '--', name, `${startPoint}^{commit}`], execution)
    ).catch((error) => {
      if (/already exists/.test(readGitCommandFailureStderr(error) ?? '')) {
        throw new BranchSwitchCollisionError(name)
      }
      throw new Error(
        "Orca couldn't create the branch. Check this repository in a terminal, then try again."
      )
    })
    return { outcome: 'landed', branch: name, commitId: startPoint.toLowerCase() }
  })
}
