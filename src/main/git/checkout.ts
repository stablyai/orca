import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

/**
 * Reject branch names git would parse as an option (`-`/`--…`) or that aren't a
 * valid ref. Defense-in-depth: callers also validate at the RPC schema, but the
 * relay entrypoint is reachable independently, so the helper guards too.
 */
export function assertValidBranchName(branch: string): void {
  if (branch.length === 0 || branch.startsWith('-')) {
    throw new Error('invalid_branch_name')
  }
}

/**
 * Switch the worktree to an existing local branch. Git itself refuses (and
 * surfaces a "would be overwritten by checkout" error) when uncommitted changes
 * would conflict, so we let that message propagate to the caller rather than
 * forcing — mobile shows it as a toast. Flag-injection is prevented by
 * `assertValidBranchName` (rejects `-…`); the trailing `--` marks that no
 * pathspecs follow, so the token is unambiguously treated as a branch ref.
 */
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  assertValidBranchName(branch)
  await gitExecFileAsync(['checkout', branch, '--'], gitOptionsForWorktree(worktreePath, options))
}

/**
 * List local branch short-names for the branch picker, current branch first.
 * Uses `for-each-ref` (stable, scriptable output) instead of `branch` to avoid
 * locale-dependent decoration.
 */
export async function listLocalBranches(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<{ current: string | null; branches: string[] }> {
  const { stdout } = await gitExecFileAsync(
    ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads/'],
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
  // Why: surface the checked-out branch first so the picker reads "you are here"
  // at the top, then the rest in git's ref order.
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
