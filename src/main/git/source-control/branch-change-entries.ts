import type { GitBranchChangeEntry } from '../../../shared/git-diff-compare-types'
import { gitChangeListArgs, parseGitChangeList } from '../../../shared/git-change-list'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'

export async function loadBranchChanges(
  worktreePath: string,
  mergeBase: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchChangeEntry[]> {
  return loadCommitChanges(worktreePath, mergeBase, headOid, options)
}

export async function loadCommitChanges(
  worktreePath: string,
  parentOid: string | null,
  commitOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchChangeEntry[]> {
  const { stdout } = await gitExecFileAsync(gitChangeListArgs(parentOid, commitOid), {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  })
  return parseGitChangeList(stdout)
}
