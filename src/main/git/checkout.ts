import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

/** Reject empty and option-like names here too: relay callers can bypass RPC schema validation. */
export function assertValidBranchName(branch: string): void {
  if (branch.length === 0 || branch.startsWith('-')) {
    throw new Error('invalid_branch_name')
  }
}

/** Leave conflicting changes to Git; trailing -- disambiguates the branch from pathspecs. */
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  assertValidBranchName(branch)
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['checkout', branch, '--'], gitOptionsForWorktree(worktreePath, options))
  )
}

/** for-each-ref avoids localized branch decoration; return the current branch first. */
export async function listLocalBranches(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<{ current: string | null; branches: string[] }> {
  const { stdout } = await gitExecFileAsync(
    ['for-each-ref', '--format=%(HEAD)%09%(refname:lstrip=2)', 'refs/heads/'],
    gitOptionsForWorktree(worktreePath, options)
  )
  let current: string | null = null
  const branches: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      continue
    }
    const [marker, name] = line.split('\t')
    if (!name) {
      continue
    }
    if (marker === '*') {
      current = name
    }
    branches.push(name)
  }
  branches.sort((a, b) => {
    if (a === current) {
      return -1
    }
    if (b === current) {
      return 1
    }
    return 0
  })
  return { current, branches }
}
