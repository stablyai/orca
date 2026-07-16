import { UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE } from '../shared/worktree-removal'
import { formatWorktreeRemovalError } from './ipc/worktree-logic'

/**
 * Runs git with the given argv inside the worktree being removed and resolves
 * with its stdout. Implementations must reject (or be wrapped to reject) on any
 * non-zero exit so the guard fails closed.
 */
export type SubmoduleRemovalGuardGitExec = (args: string[]) => Promise<{ stdout: string }>

// Why: the guard runs one status and one rev-list sweep on an explicit user
// delete; a large tree on a slow link should fail closed instead of hanging.
const SSH_SUBMODULE_REMOVAL_GUARD_TIMEOUT_MS = 30_000

type NonInteractiveExecProvider = {
  execNonInteractive(
    binary: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{ stdout: string; exitCode: number | null; timedOut: boolean; spawnError?: string }>
}

export function sshSubmoduleRemovalGuardGitExec(
  provider: NonInteractiveExecProvider,
  worktreePath: string
): SubmoduleRemovalGuardGitExec {
  return async (gitArgs) => {
    const result = await provider.execNonInteractive(
      'git',
      gitArgs,
      worktreePath,
      SSH_SUBMODULE_REMOVAL_GUARD_TIMEOUT_MS
    )
    if (result.timedOut || result.spawnError || result.exitCode !== 0) {
      throw new Error(result.spawnError || `git ${gitArgs[0]} exited with ${result.exitCode}`)
    }
    return { stdout: result.stdout }
  }
}

/**
 * Verify a submodule-containing worktree is safe to remove with `--force`
 * after git refused the non-forced removal.
 *
 * `--force` skips git's own cleanliness check and deletes the worktree admin
 * dir (`.git/worktrees/<id>`), which holds every initialized submodule's git
 * database under `modules/`. Two states make that destructive beyond what a
 * normal worktree removal discards, and each is re-checked here, directly
 * before the forced retry:
 *
 * 1. Dirty state anywhere in the tree — checked with `--ignore-submodules=none`
 *    because plain `git status` honors `diff.ignoreSubmodules` /
 *    `submodule.<name>.ignore` config that can hide dirty submodules.
 * 2. Submodule commits that exist on no remote — deleting the worktree-scoped
 *    submodule git database is their only copy, and the preserved branch's
 *    gitlink would reference a commit that no longer exists anywhere.
 *
 * Submodules that are declared but not active (`git submodule status` shows a
 * leading `-`, e.g. after `git submodule deinit`) cannot be verified — a
 * deinit leaves the submodule's database under the admin dir, invisible to
 * `git submodule foreach` — so they require explicit force too. The one
 * residual gap is a leftover database whose submodule was also removed from
 * .gitmodules: no porcelain command can see it, and git's own sanctioned
 * `worktree remove --force` destroys it identically.
 * Throws a force-classifiable error when unsafe; rethrows the original
 * removal error when the state cannot be verified.
 */
export async function assertSubmoduleWorktreeSafeToForceRemove(
  runGitInWorktree: SubmoduleRemovalGuardGitExec,
  originalRemovalError: unknown,
  worktreePath: string
): Promise<void> {
  let statusStdout: string
  let submoduleStates: string
  let localOnlyCommitCounts: string
  try {
    statusStdout = (
      await runGitInWorktree([
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ])
    ).stdout
    submoduleStates = (await runGitInWorktree(['submodule', 'status', '--recursive'])).stdout
    localOnlyCommitCounts = (
      await runGitInWorktree([
        'submodule',
        'foreach',
        '--recursive',
        '--quiet',
        'git rev-list --count HEAD --not --remotes'
      ])
    ).stdout
  } catch {
    // Why: an unverifiable tree must not be force-deleted; surface the
    // original refusal so the user keeps the explicit force-delete choice.
    throw new Error(formatWorktreeRemovalError(originalRemovalError, worktreePath, false))
  }

  if (statusStdout.trim()) {
    const dirtyError = new Error('Worktree has uncommitted or untracked changes.')
    ;(dirtyError as Error & { stdout?: string }).stdout = statusStdout
    throw dirtyError
  }

  const hasUnverifiableSubmodule = submoduleStates.split('\n').some((line) => line.startsWith('-'))
  const hasLocalOnlySubmoduleCommits = localOnlyCommitCounts
    .split('\n')
    .some((line) => Number.parseInt(line.trim(), 10) > 0)
  if (hasUnverifiableSubmodule || hasLocalOnlySubmoduleCommits) {
    throw new Error(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE)
  }
}
