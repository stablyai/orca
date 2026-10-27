import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import {
  syncForkDefaultBranch,
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult
} from '../../shared/git-fork-sync'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'

export async function gitSyncForkDefaultBranch(
  worktreePath: string,
  expectedUpstream: GitForkSyncExpectedUpstream,
  options: GitRuntimeOptions = {}
): Promise<GitForkSyncResult> {
  const signal = abortSignalWithTimeout(options.signal, 60_000)
  try {
    return await syncForkDefaultBranch(
      (args) =>
        gitExecFileAsync(args, {
          ...gitOptionsForWorktree(worktreePath, options),
          timeout: 60_000,
          signal
        }),
      { expectedUpstream }
    )
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}
