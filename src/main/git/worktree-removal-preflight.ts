import { join } from 'node:path'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { isWorktreePathMissing } from '../worktree-removal-safety'
import {
  SUBMODULE_DIRTY_REMOVAL_DETAIL,
  SUBMODULE_REMOVAL_REFUSAL
} from '../../shared/worktree/removal'
import { gitExecFileAsync } from './runner'
import { resolveGitDir } from './source-control/resolve-git-dir'
import type { WorktreeRemovalPreflightOptions } from './worktree-operation-options'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS, gitExecOptions } from './worktree-operation-options'

export async function assertWorktreeCleanForRemoval(
  worktreePath: string,
  force = false,
  options: WorktreeRemovalPreflightOptions = {},
  adminDirectory?: string
): Promise<void> {
  if (force) {
    return
  }

  const { ignoredUntrackedPaths = [], ...gitOptions } = options
  const bound = adminDirectory
    ? { env: { ...process.env, GIT_DIR: join(worktreePath, '.git'), GIT_WORK_TREE: worktreePath } }
    : {}
  const execution = {
    ...gitExecOptions(worktreePath, gitOptions),
    ...bound,
    timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
  }
  // Native Windows deletion bypasses Git, so Git's refusal must hold here, before any status read.
  if (
    adminDirectory &&
    (await containsSubmoduleCheckout(worktreePath, execution, adminDirectory))
  ) {
    throw new Error(SUBMODULE_DIRTY_REMOVAL_DETAIL)
  }
  // Windows refused above; elsewhere Git re-checks on delete, so a failed probe leaves the decision to Git.
  const hasSubmoduleCheckout = async (): Promise<boolean> =>
    !adminDirectory &&
    containsSubmoduleCheckout(
      resolveWorktreeHostPath(worktreePath, gitOptions) ?? worktreePath,
      execution,
      await resolveGitDir(worktreePath, gitOptions)
    ).catch(() => false)
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
    execution
  )
  // Use the same entries for the verdict and the error message.
  const blockingEntries = useNullTerminatedStatus
    ? getBlockingUntrackedStatusEntries(stdout, ignoredUntrackedPaths)
    : null
  if (blockingEntries ? blockingEntries.length === 0 : !stdout.trim()) {
    // Git refuses these even when clean; refuse before teardown instead of after terminals stop.
    if (await hasSubmoduleCheckout()) {
      throw new Error(SUBMODULE_REMOVAL_REFUSAL)
    }
    return
  }

  const blockingStatus = blockingEntries ? blockingEntries.join('\n') : stdout
  if (await hasSubmoduleCheckout()) {
    // Force Delete also destroys submodule-only commits; put that detail before stdout for the formatter.
    throw new Error(`${SUBMODULE_DIRTY_REMOVAL_DETAIL}\n${blockingStatus.trim()}`)
  }

  // Render filtered entries without raw NULs or tolerated shared links.
  throw Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
    stdout: blockingStatus
  })
}

/** Git's own refusal test: submodule repositories under the admin directory, or a gitlink checked out with its `.git`. */
async function containsSubmoduleCheckout(
  hostWorktreePath: string,
  execution: Parameters<typeof gitExecFileAsync>[1],
  adminDirectory: string | null
): Promise<boolean> {
  if (adminDirectory && !(await isWorktreePathMissing(join(adminDirectory, 'modules')))) {
    return true
  }
  const { stdout: index } = await gitExecFileAsync(['ls-files', '--stage', '-z'], execution)
  for (const entry of index.split('\0')) {
    if (
      entry.startsWith('160000 ') &&
      !(await isWorktreePathMissing(
        join(hostWorktreePath, entry.slice(entry.indexOf('\t') + 1), '.git')
      ))
    ) {
      return true
    }
  }
  return false
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
