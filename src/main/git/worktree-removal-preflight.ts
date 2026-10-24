import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SUBMODULE_DIRTY_REMOVAL_DETAIL } from '../../shared/worktree/removal'
import { gitExecFileAsync } from './runner'
import type { WorktreeRemovalPreflightOptions } from './worktree-operation-options'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS, gitExecOptions } from './worktree-operation-options'

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
      // User ignore-submodules config must not hide edits from the dirty check.
      '--ignore-submodules=none'
    ],
    {
      ...gitExecOptions(worktreePath, gitOptions),
      timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
    }
  )
  // Use the same entries for the verdict and the error message.
  const blockingEntries = useNullTerminatedStatus
    ? getBlockingUntrackedStatusEntries(stdout, ignoredUntrackedPaths)
    : null
  if (blockingEntries ? blockingEntries.length === 0 : !stdout.trim()) {
    return
  }

  const blockingStatus = blockingEntries ? blockingEntries.join('\n') : stdout
  if (await hasPopulatedSubmodule(worktreePath, gitOptions)) {
    // Force Delete also destroys submodule-only commits; put that detail before stdout for the formatter.
    throw new Error(`${SUBMODULE_DIRTY_REMOVAL_DETAIL}\n${blockingStatus.trim()}`)
  }

  // Render filtered entries without raw NULs or tolerated shared links.
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

/** Exclude only the untracked shared links tolerated by the caller. */
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
