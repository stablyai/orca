import type {
  GitStashEntry,
  GitStashMutationResult,
  GitStashPushOptions,
  GitStashPushResult
} from '../../shared/git-stash-types'
import type { GitStashExec } from '../../shared/git-stash-commands'
import {
  applyStashWith,
  clearStashesWith,
  dropStashWith,
  listStashesWith,
  popStashWith,
  stashChangesWith
} from '../../shared/git-stash-commands'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

export { assertValidStashRef } from '../../shared/git-stash-commands'

/**
 * Local/WSL host adapter over the shared stash commands. The command shapes and
 * result contracts live in `src/shared/git-stash-commands` so the relay runs the
 * exact same logic on the remote host — no drift between transports.
 */
function localStashExec(options: GitRuntimeOptions): GitStashExec {
  return (args, cwd) => gitExecFileAsync(args, gitOptionsForWorktree(cwd, options))
}

export async function listStashes(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitStashEntry[]> {
  return listStashesWith(localStashExec(options), worktreePath)
}

export async function stashChanges(
  worktreePath: string,
  pushOptions: GitStashPushOptions = {},
  options: GitRuntimeOptions = {}
): Promise<GitStashPushResult> {
  return runWithGitReadCacheInvalidation(() =>
    stashChangesWith(localStashExec(options), worktreePath, pushOptions)
  )
}

export async function applyStash(
  worktreePath: string,
  ref: string | null,
  expectedCommitOid?: string,
  options: GitRuntimeOptions = {}
): Promise<GitStashMutationResult> {
  return runWithGitReadCacheInvalidation(() =>
    applyStashWith(localStashExec(options), worktreePath, ref, expectedCommitOid)
  )
}

export async function popStash(
  worktreePath: string,
  ref: string | null,
  expectedCommitOid?: string,
  options: GitRuntimeOptions = {}
): Promise<GitStashMutationResult> {
  return runWithGitReadCacheInvalidation(() =>
    popStashWith(localStashExec(options), worktreePath, ref, expectedCommitOid)
  )
}

export async function dropStash(
  worktreePath: string,
  ref: string,
  expectedCommitOid?: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    dropStashWith(localStashExec(options), worktreePath, ref, expectedCommitOid)
  )
}

export async function clearStashes(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    clearStashesWith(localStashExec(options), worktreePath)
  )
}
