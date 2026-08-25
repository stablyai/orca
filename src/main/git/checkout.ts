import {
  LOCAL_BRANCH_LISTING_ARGV,
  parseLocalBranchListing,
  type GitLocalBranchListing
} from '../../shared/git-local-branches'
import { assertValidGitBranchName } from '../../shared/git-branch-name'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

/**
 * Switch the worktree to an existing local branch. Git itself refuses (and
 * surfaces a "would be overwritten by checkout" error) when uncommitted changes
 * would conflict, so we let that message propagate to the caller rather than
 * forcing — clients show it verbatim. Flag-injection is prevented by
 * `assertValidGitBranchName` (rejects `-…`); the trailing `--` marks that no
 * pathspecs follow, so the token is unambiguously treated as a branch ref.
 */
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  assertValidGitBranchName(branch)
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['checkout', branch, '--'], gitOptionsForWorktree(worktreePath, options))
  )
}

/**
 * Create a branch at the current HEAD and switch to it. `checkout -b` (not
 * `switch -c`) because `switch` is Git 2.23 and still experimental at the 2.25
 * baseline. Git rejects a name that already exists, which is the behavior we
 * want: the picker offers "Create" only for names it did not list, and a race
 * against an outside creation should fail loudly rather than silently switch.
 */
export async function createAndCheckoutBranch(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  assertValidGitBranchName(branch)
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(
      ['checkout', '-b', branch, '--'],
      gitOptionsForWorktree(worktreePath, options)
    )
  )
}

/** List local branches for the branch picker, current branch first. */
export async function listLocalBranches(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitLocalBranchListing> {
  const { stdout } = await gitExecFileAsync(
    [...LOCAL_BRANCH_LISTING_ARGV],
    gitOptionsForWorktree(worktreePath, options)
  )
  return parseLocalBranchListing(stdout)
}
