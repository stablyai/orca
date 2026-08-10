import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import {
  syncForkDefaultBranch,
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult
} from '../../shared/git-fork-sync'
import type { GitRuntimeOptions } from './git-runtime-options'
import {
  gitRemoteOperationOptionsForWorktree,
  runLocalGitRemoteOperation
} from './git-remote-operation-options'
import { gitExecFileAsync } from './runner'

export async function gitSyncForkDefaultBranch(
  worktreePath: string,
  expectedUpstream: GitForkSyncExpectedUpstream,
  options: GitRuntimeOptions = {}
): Promise<GitForkSyncResult> {
  if (!options.remoteOperationDeadline) {
    return runLocalGitRemoteOperation(options, (remoteOptions) =>
      gitSyncForkDefaultBranch(worktreePath, expectedUpstream, remoteOptions)
    )
  }
  try {
    return await syncForkDefaultBranch(
      (args) => gitExecFileAsync(args, gitRemoteOperationOptionsForWorktree(worktreePath, options)),
      { expectedUpstream }
    )
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}
