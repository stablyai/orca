import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../shared/git/commands/git-commit-action'
import { readGitCommandFailureStderr } from '../../shared/git/commands/git-command-failure-text'
import { withCheckoutLock } from './branch-switch'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './source-control/git-read-cache-invalidation'

export async function applyCommit(
  worktreePath: string,
  operation: GitCommitAction,
  commitId: string,
  options: GitRuntimeOptions = {}
): Promise<GitCommitActionResult> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitId)) {
    throw new Error('Expected a full git object id')
  }
  return withCheckoutLock(worktreePath, async () => {
    const execution = gitOptionsForWorktree(worktreePath, options)
    const { stdout: parents } = await gitExecFileAsync(
      ['show', '--no-patch', '--format=%P', commitId, '--'],
      execution
    )
    if (parents.trim().split(/\s+/).filter(Boolean).length > 1) {
      return { outcome: 'refused', message: `Can't ${operation} a merge commit from here` }
    }
    const readHead = async () =>
      (await gitExecFileAsync(['rev-parse', 'HEAD'], execution)).stdout.trim()
    const before = await readHead()
    let failure: unknown
    try {
      await runWithGitReadCacheInvalidation(() =>
        gitExecFileAsync([operation, '--no-edit', commitId], execution)
      )
    } catch (error) {
      failure = error
    }
    const commit = await readHead()
    const { stdout: branch } = await gitExecFileAsync(['branch', '--show-current'], execution)
    if (commit !== before) {
      return {
        outcome: failure ? 'landed-with-warning' : 'landed',
        commitId: commit,
        branch: branch.trim(),
        ...(failure
          ? {
              message:
                readGitCommandFailureStderr(failure) ??
                'Git reported an error after creating the commit.'
            }
          : {})
      }
    }
    const stderr = readGitCommandFailureStderr(failure) ?? ''
    if (operation === 'cherry-pick' && /The previous cherry-pick is now empty/.test(stderr)) {
      await runWithGitReadCacheInvalidation(() =>
        gitExecFileAsync(['cherry-pick', '--abort'], execution)
      )
      return { outcome: 'empty', message: 'Already applied, nothing to cherry-pick' }
    }
    const { stdout: conflicts } = await gitExecFileAsync(
      ['diff', '--name-only', '--diff-filter=U'],
      execution
    )
    if (conflicts.trim()) {
      return { outcome: 'conflicted' }
    }
    return {
      outcome: 'refused',
      message: stderr.trim() || 'Git did not create a commit. Check the checkout and try again.'
    }
  })
}
