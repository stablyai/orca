import { gitExecFileAsync } from './runner'
import type { WorktreeRemovalPreflightOptions } from './worktree-operation-options'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS, gitExecOptions } from './worktree-operation-options'

/**
 * Assert a worktree is clean enough for non-force removal.
 */
export async function assertWorktreeCleanForRemoval(
  worktreePath: string,
  force = false,
  options: WorktreeRemovalPreflightOptions = {}
): Promise<void> {
  if (force) {
    return
  }

  const { ignoredUntrackedPaths = [], ...gitOptions } = options
  const useNullTerminatedStatus = ignoredUntrackedPaths.length > 0
  const { stdout } = await gitExecFileAsync(
    ['status', '--porcelain', ...(useNullTerminatedStatus ? ['-z'] : []), '--untracked-files=all'],
    {
      ...gitExecOptions(worktreePath, gitOptions),
      timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
    }
  )
  // Why one parse feeds both: the clean verdict and the error text must never
  // disagree about which entries block removal.
  const blockingEntries = useNullTerminatedStatus
    ? getBlockingUntrackedStatusEntries(stdout, ignoredUntrackedPaths)
    : null
  if (blockingEntries ? blockingEntries.length === 0 : !stdout.trim()) {
    return
  }

  const error = new Error('Worktree has uncommitted or untracked changes.')
  // Why not the raw stdout: `-z` output is NUL-delimited and `.trim()` leaves
  // interior NULs, so attaching it verbatim put raw control bytes into the
  // user-facing removal error — and listed the tolerated shared link, the one
  // entry that is not the user's work and cannot be committed away.
  ;(error as Error & { stdout?: string }).stdout = blockingEntries
    ? blockingEntries.join('\n')
    : stdout
  throw error
}

/** The `git status --porcelain -z` entries that genuinely block removal:
 *  everything except the untracked shared links the caller tolerates. */
function getBlockingUntrackedStatusEntries(
  status: string,
  ignoredUntrackedPaths: readonly string[]
): string[] {
  const ignored = new Set(
    ignoredUntrackedPaths
      .map((entry) =>
        entry
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/')
      )
      .filter((entry) => entry && !entry.split('/').includes('..'))
  )
  return status
    .split('\0')
    .filter(Boolean)
    .filter(
      (entry) => !(entry.startsWith('?? ') && ignored.has(entry.slice(3).replace(/\\/g, '/')))
    )
}
