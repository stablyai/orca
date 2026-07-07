import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import {
  syncForkDefaultBranch,
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult
} from '../../shared/git-fork-sync'
import {
  addUpstreamRemote,
  type GitAddUpstreamRemoteResult
} from '../../shared/git-upstream-remote'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

export async function gitSyncForkDefaultBranch(
  worktreePath: string,
  expectedUpstream: GitForkSyncExpectedUpstream,
  options: GitRuntimeOptions = {}
): Promise<GitForkSyncResult> {
  // Compose the caller's cancel signal with the 60s timeout so neither is lost —
  // the caller's signal was previously clobbered by the timeout controller.
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000)
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

export async function gitAddUpstreamRemote(
  worktreePath: string,
  expectedUpstream: GitForkSyncExpectedUpstream,
  options: GitRuntimeOptions = {}
): Promise<GitAddUpstreamRemoteResult> {
  return addUpstreamRemote(
    (args) =>
      gitExecFileAsync(args, {
        ...gitOptionsForWorktree(worktreePath, options),
        timeout: 30_000
      }),
    expectedUpstream
  )
}
