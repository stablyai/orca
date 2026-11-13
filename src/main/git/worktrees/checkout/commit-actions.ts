import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectConflictOperation } from '../../source-control/mutations/git-conflict-operation'
import type {
  GitCommitAction,
  GitCommitActionResult
} from '../../../../shared/git/commands/git-commit-action'
import { readGitCommandFailureStderr } from '../../../../shared/git/commands/git-command-failure-text'
import { gitFailureLine, withCheckoutLock } from './branch-switch'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import { bulkPathspecCommands } from '../../source-control/git-pathspec'
import { resolveGitDir } from '../../source-control/resolve-git-dir'

function throwSequencerFailure(error: unknown): never {
  throw new Error(
    gitFailureLine(readGitCommandFailureStderr(error) ?? '') ??
      'Could not finish the operation. Refresh Source Control and try again.'
  )
}

async function commitActionDiffRefs(
  operationHead: string,
  execution: ReturnType<typeof gitOptionsForWorktree>
): Promise<string[]> {
  const { stdout } = await gitExecFileAsync(
    ['show', '--no-patch', '--format=%P', operationHead, '--'],
    execution
  )
  const parents = stdout.trim().split(/\s+/).filter(Boolean)
  if (parents.length > 1) {
    try {
      const gitDir = await resolveGitDir(execution.cwd, execution)
      const opts = await readFile(join(gitDir, 'sequencer', 'opts'), 'utf8')
      const { stdout: mainline } = await gitExecFileAsync(
        ['config', '--file', '-', '--int', '--get', 'options.mainline'],
        { ...execution, stdin: opts }
      )
      const parent = parents[Number(mainline.trim()) - 1]
      if (parent) {
        return [parent, operationHead]
      }
    } catch {}
    // Single-item operations may omit opts; the union protects every possible resolution.
  }
  return [operationHead]
}

async function finishEmptyCommitAction(
  operation: GitCommitAction,
  execution: ReturnType<typeof gitOptionsForWorktree>,
  action: 'apply' | 'continue'
): Promise<GitCommitActionResult | undefined> {
  try {
    if ((await detectConflictOperation(execution.cwd, execution)) !== operation) {
      return undefined
    }
    const { stdout: unmerged } = await gitExecFileAsync(['ls-files', '-u'], execution)
    if (unmerged.trim()) {
      return undefined
    }
    await gitExecFileAsync(
      ['diff-index', '--cached', '--quiet', '--ignore-submodules=none', 'HEAD', '--'],
      execution
    )
    if (action === 'continue') {
      const refs = await commitActionDiffRefs(
        operation === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD',
        execution
      )
      const { stdout: paths } = await gitExecFileAsync(
        [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          '--root',
          '-m',
          '--no-renames',
          '--ignore-submodules=none',
          ...refs,
          '--'
        ],
        execution
      )
      for (const args of bulkPathspecCommands(
        ['diff-files', '--quiet', '--ignore-submodules=none', '--'],
        paths.split('\0').filter(Boolean),
        execution.cwd,
        execution,
        'git'
      )) {
        await gitExecFileAsync(args, execution)
      }
    }
  } catch {
    return undefined
  }
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync([operation, '--skip'], {
      ...execution,
      env: { ...process.env, GIT_EDITOR: 'true' }
    })
  )
  return {
    outcome: 'empty',
    message:
      operation === 'revert'
        ? 'Nothing to revert; the changes are already undone.'
        : 'Already applied, nothing to cherry-pick'
  }
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
    const empty = failure
      ? await finishEmptyCommitAction(operation, execution, 'apply').catch(throwSequencerFailure)
      : undefined
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
    const inProgress = await detectConflictOperation(worktreePath, options).catch(
      throwSequencerFailure
    )
    if (inProgress !== operation) {
      throw new Error(`There is no ${operation} in progress. Refresh Source Control and try again.`)
    }
    const execution = gitOptionsForWorktree(worktreePath, options)
    return runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync([operation, `--${action}`], {
        ...execution,
        ...(action === 'continue' ? { env: { ...process.env, GIT_EDITOR: 'true' } } : {})
      })
    )
      .then(() => undefined)
      .catch(async (error: unknown) => {
        const empty =
          action === 'continue' && (await finishEmptyCommitAction(operation, execution, action))
        if (empty) {
          return empty
        }
        throw error
      })
      .catch(throwSequencerFailure)
  })
}
