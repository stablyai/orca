import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SUBMODULE_DIRTY_REMOVAL_DETAIL } from '../../shared/worktree/removal'
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
    [
      'status',
      '--porcelain',
      ...(useNullTerminatedStatus ? ['-z'] : []),
      '--untracked-files=all',
      // Why: a user's ignore-submodules setting would hide submodule edits from this dirty check.
      '--ignore-submodules=none'
    ],
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

  const blockingStatus = blockingEntries ? blockingEntries.join('\n') : stdout
  if (await hasPopulatedSubmodule(worktreePath, gitOptions)) {
    // Why: Force Delete also destroys the submodules' never-pushed commits, which the parent's
    // status cannot show, so the refusal must say submodules. Status lines go after the detail
    // because the formatter prefers stdout over the message.
    throw new Error(`${SUBMODULE_DIRTY_REMOVAL_DETAIL}\n${blockingStatus.trim()}`)
  }

  // Why not the raw stdout: `-z` output is NUL-delimited and `.trim()` leaves
  // interior NULs, so attaching it verbatim put raw control bytes into the
  // user-facing removal error — and listed the tolerated shared link, the one
  // entry that is not the user's work and cannot be committed away.
  throw Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
    stdout: blockingStatus
  })
}

/** Git's main submodule refusal test: a `.gitmodules` path whose directory holds a `.git`. */
async function hasPopulatedSubmodule(
  worktreePath: string,
  gitOptions: Omit<WorktreeRemovalPreflightOptions, 'ignoredUntrackedPaths'>
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      {
        ...gitExecOptions(worktreePath, gitOptions),
        timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
      }
    )
    const paths = stdout
      .split('\0')
      .map((entry) => entry.slice(entry.indexOf('\n') + 1))
      .filter(Boolean)
    const populated = await Promise.all(
      paths.map((path) =>
        stat(join(worktreePath, path, '.git')).then(
          () => true,
          () => false
        )
      )
    )
    return populated.includes(true)
  } catch {
    // No .gitmodules exits non-zero. Any failure keeps the plain dirty refusal, which still blocks.
    return false
  }
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
