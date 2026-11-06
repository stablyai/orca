import { detectConflictOperation } from './source-control/git-conflict-operation'
import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../shared/git/commands/git-commit-action'
import { readGitCommandFailureStderr } from '../../shared/git/commands/git-command-failure-text'
import { withCheckoutLock } from './branch-switch'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './source-control/git-read-cache-invalidation'

async function abortEmptyCherryPick(
  operation: GitCommitAction,
  error: unknown,
  execution: ReturnType<typeof gitOptionsForWorktree>
): Promise<GitCommitActionResult | undefined> {
  if (
    operation !== 'cherry-pick' ||
    !/The previous cherry-pick is now empty/.test(readGitCommandFailureStderr(error) ?? '')
  ) {
    return undefined
  }
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['cherry-pick', '--abort'], execution)
  )
  return { outcome: 'empty', message: 'Already applied, nothing to cherry-pick' }
}

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
    const inProgress = await detectConflictOperation(worktreePath, options)
    if (inProgress !== 'unknown') {
      return {
        outcome: 'refused',
        message: `Finish or abort the ${inProgress} in progress before trying again.`
      }
    }
    const { stdout: parents } = await gitExecFileAsync(
      ['show', '--no-patch', '--format=%P', commitId, '--'],
      execution
    )
    if (parents.trim().split(/\s+/).filter(Boolean).length > 1) {
      return { outcome: 'refused', message: `Can't ${operation} a merge commit from here` }
    }
    const readHead = async () =>
      gitExecFileAsync(['rev-parse', '--verify', '--quiet', 'HEAD'], execution)
        .then(({ stdout }) => stdout.trim())
        .catch(() => null)
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
    if (commit && commit !== before) {
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
    const empty = await abortEmptyCherryPick(operation, failure, execution)
    if (empty) {
      return empty
    }
    const { stdout: conflicts } = await gitExecFileAsync(
      ['diff', '--name-only', '--diff-filter=U'],
      execution
    )
    if (conflicts.trim() && (await detectConflictOperation(worktreePath, options)) === operation) {
      return { outcome: 'conflicted' }
    }
    return {
      outcome: 'refused',
      message: /would be overwritten|local changes.*would|commit your changes or stash/i.test(
        stderr
      )
        ? 'Commit or stash your changes, then try again.'
        : 'Git did not create a commit. Check the checkout and try again.'
    }
  })
}

export async function recoverSequencer(
  worktreePath: string,
  operation: GitCommitAction,
  action: 'abort' | 'continue',
  options: GitRuntimeOptions = {}
): Promise<GitCommitActionResult | void> {
  if (operation !== 'cherry-pick' && operation !== 'revert') {
    throw new Error('Expected cherry-pick or revert')
  }
  return withCheckoutLock(worktreePath, async () => {
    if ((await detectConflictOperation(worktreePath, options)) !== operation) {
      throw new Error(`There is no ${operation} in progress. Refresh Source Control and try again.`)
    }
    const execution = gitOptionsForWorktree(worktreePath, options)
    try {
      await runWithGitReadCacheInvalidation(() =>
        gitExecFileAsync([operation, `--${action}`], {
          ...execution,
          ...(action === 'continue' ? { env: { ...process.env, GIT_EDITOR: 'true' } } : {})
        })
      )
    } catch (error) {
      const empty =
        action === 'continue' && (await abortEmptyCherryPick(operation, error, execution))
      if (empty) {
        return empty
      }
      throw error
    }
    return undefined
  })
}
