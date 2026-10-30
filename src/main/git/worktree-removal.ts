import { lstat } from 'node:fs/promises'
import { pruneGitWorktrees } from './worktree-prune-guard'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { removeHostTree } from '../host-tree-removal'
import { withSpan } from '../observability/tracer'
import { parseWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import type { RemoveWorktreeOptions } from './worktree-operation-options'
import { getErrorCode, gitExecOptions, normalizeLocalBranchRef } from './worktree-operation-options'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { bumpWorktreeScanGeneration, listWorktrees } from './worktree-scan-cache'
import { invalidateSparseCheckoutState } from './worktree-sparse-checkout-cache'
import { runUnderWorktreeDeleteLimit } from './worktree-delete-limit'
import { removeWindowsCheckout, usesNativeWindowsRemoval } from './windows-worktree-removal'
import { listWorktreesStrict } from './worktree-listing'
import { isWorktreePathMissing } from '../worktree-removal-safety'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'

const branchCleanupQueueByRepo = new Map<string, Promise<void>>()

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  // Reserve forceBranchDelete for failed-creation rollback so user deletes preserve unmerged commits.
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  options = removalWorkerOptions(options)
  try {
    // Wait out ref packing before deleting branches; concurrent pruning can finish safely.
    return await withRepoRefMaintenancePaused('worktree-remove', () =>
      runWithGitReadCacheInvalidation(() =>
        performRemoveWorktree(repoPath, worktreePath, force, options)
      )
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    invalidateSparseCheckoutState(repoPath, worktreePath)
    bumpWorktreeScanGeneration(repoPath)
  }
}

async function performRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  const removedWorktree =
    options.knownRemovedWorktree !== undefined
      ? options.knownRemovedWorktree
      : ((await listWorktrees(repoPath, options)).find((worktree) =>
          areWorktreePathsEqual(worktree.path, worktreePath)
        ) ?? null)
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  // Enforce locks even for callers that bypass IPC/runtime preflight.
  assertWorktreeUnlockedForRemoval(removedWorktree ?? undefined)

  // Avoid default deadlines during large deletes; preserve Windows long-path support used at creation.
  const longPathArgs = windowsLongPathGitArgs(repoPath)
  const execOptions = {
    ...gitExecOptions(repoPath, options),
    ...(options.checkoutDeleteSignal ? { signal: options.checkoutDeleteSignal } : {}),
    ...removalGitEnv(),
    admissionExempt: true as const
  }
  const args = [...longPathArgs, 'worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await runUnderWorktreeDeleteLimit(async () => {
    if (usesNativeWindowsRemoval(worktreePath, options)) {
      await removeWindowsCheckout(repoPath, worktreePath, force, {
        ...options,
        knownRemovedWorktree: removedWorktree
      })
      // Release only this administrative entry, and never override a newly acquired Git lock.
      if (
        (await listWorktreesStrict(repoPath, options)).some((row) =>
          areWorktreePathsEqual(row.path, worktreePath)
        )
      ) {
        if (!(await isWorktreePathMissing(worktreePath))) {
          throw new Error(
            `Worktree path appeared during deletion: ${worktreePath}. Retry deletion.`
          )
        }
        await gitExecFileAsync(
          [...longPathArgs, 'worktree', 'remove', '--force', '--', worktreePath],
          execOptions
        )
      }
    } else {
      await gitExecFileAsync(args, execOptions)
      await removeCheckoutLeftByGit(worktreePath, options)
    }
  })

  if (!branchName) {
    return {}
  }
  if (options.deleteBranch === false) {
    return {}
  }

  return deleteBranchOfRemovedWorktree(repoPath, branchName, branchHead, options)
}

function deleteBranchOfRemovedWorktree(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: RemoveWorktreeOptions
): Promise<RemoveWorktreeResult> {
  // Time network-capable branch cleanup separately and serialize per repo to avoid ref-lock races.
  return runKeyedSerializedOperation(branchCleanupQueueByRepo, repoPath, () =>
    withSpan('worktree.remove.branch_delete', () =>
      deleteBranchAfterWorktreeRemoval(repoPath, branchName, branchHead, options)
    )
  )
}

/** Prune stale registration and clean up the branch only after the caller verifies the checkout is gone. */
export async function finishUnregisteredWorktreeRemoval(
  repoPath: string,
  worktreePath: string,
  branch: { name: string; head: string } | null,
  assertCheckoutGone: () => Promise<void>,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  options = removalWorkerOptions(options)
  await assertCheckoutGone()
  await pruneGitWorktrees(gitExecOptions(repoPath, options)).catch((error: unknown) =>
    console.warn(`[git] worktree prune failed in ${repoPath}`, error)
  )
  return deleteBranchOfUnregisteredWorktree(repoPath, worktreePath, branch, options)
}

/** Clean up an unregistered checkout's branch using normal preservation rules, without deleting files. */
export async function deleteBranchOfUnregisteredWorktree(
  repoPath: string,
  worktreePath: string,
  branch: { name: string; head: string } | null,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  options = removalWorkerOptions(options)
  try {
    if (!branch?.name || !(await localBranchExists(repoPath, branch.name, options))) {
      return {}
    }
    return await withRepoRefMaintenancePaused('worktree-remove', () =>
      deleteBranchOfRemovedWorktree(repoPath, branch.name, branch.head, options)
    )
  } finally {
    invalidateSparseCheckoutState(repoPath, worktreePath)
    bumpWorktreeScanGeneration(repoPath)
  }
}

function removalWorkerOptions(options: RemoveWorktreeOptions): RemoveWorktreeOptions {
  // uv_spawn can block even for async Git; keep native process creation off Electron's UI loop.
  return process.platform === 'darwin' ? { ...options, spawnOnWorkerThread: true } : options
}

async function localBranchExists(
  repoPath: string,
  branchName: string,
  options: RemoveWorktreeOptions
): Promise<boolean> {
  try {
    await gitExecFileAsync(
      ['show-ref', '--verify', '--quiet', '--', `refs/heads/${branchName}`],
      gitExecOptions(repoPath, options)
    )
    return true
  } catch {
    return false
  }
}

// Git for Windows may invoke GIT_ASK_YESNO for locked files; removal must never launch a prompt.
function removalGitEnv(): { env?: NodeJS.ProcessEnv } {
  const inherited = Object.keys(process.env).filter((key) => key.toUpperCase() === 'GIT_ASK_YESNO')
  if (inherited.length === 0) {
    return {}
  }
  const env = { ...process.env }
  for (const key of inherited) {
    delete env[key]
  }
  return { env }
}

// Git for Windows can exit 0 leaving junctions and parent directories; finish that accepted delete.
async function removeCheckoutLeftByGit(
  worktreePath: string,
  options: RemoveWorktreeOptions
): Promise<void> {
  // WSL-owned checkouts must be removed inside the distro.
  if (options.wslDistro || parseWslPath(worktreePath)) {
    return
  }
  try {
    await lstat(worktreePath)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return
    }
    throw error
  }
  console.warn(`[git] worktree remove left files at "${worktreePath}"; deleting them`)
  await removeHostTree(worktreePath, { signal: options.checkoutDeleteSignal })
}
