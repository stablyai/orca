import { lstat } from 'node:fs/promises'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { isSubmoduleWorktreeRemovalRefusal } from '../../shared/worktree/submodule-removal'
import { removeHostTree } from '../host-tree-removal'
import { withSpan } from '../observability/tracer'
import { parseWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'
import { listWorktreesStrict } from './worktree-listing'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import type { RemoveWorktreeOptions } from './worktree-operation-options'
import { getErrorCode, gitExecOptions, normalizeLocalBranchRef } from './worktree-operation-options'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { invalidateSparseCheckoutState } from './worktree-sparse-checkout-cache'
import { runUnderWorktreeDeleteLimit } from './worktree-delete-limit'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'

const branchCleanupQueueByRepo = new Map<string, Promise<void>>()

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  // forceBranchDelete: for failed-creation rollback (fresh branch, no user work); user deletes leave it false so unmerged commits survive.
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  try {
    // Removal deletes branches, and a ref deletion needs the packed-refs lock a
    // running idle pack holds while it rewrites. Waits that window out; the
    // prune phase that follows it is concurrency-safe and is left to finish.
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

async function listRemovalWorktrees(
  repoPath: string,
  options: RemoveWorktreeOptions
): Promise<GitWorktreeInfo[]> {
  try {
    return await listWorktreesStrict(repoPath, options)
  } catch (error) {
    // No row means no branch cleanup; Git's own `worktree remove` still refuses what it must.
    console.warn(`[git/worktree] listing before removal failed for ${repoPath}:`, error)
    return []
  }
}

async function performRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  // Git, unshared, like the rest of the removal chain: the row decides which branch gets deleted.
  const removedWorktree =
    options.knownRemovedWorktree ??
    (await listRemovalWorktrees(repoPath, options)).find((worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath)
    )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  // Why: callers outside the IPC/runtime preflight must not bypass Git's lock contract or rely on localized stderr after side effects.
  assertWorktreeUnlockedForRemoval(removedWorktree)

  // Why no timeout: this is a write, so none applies by default, and Git deletes the whole checkout
  // here (prod p90 29 s); a deadline would kill a legitimate large delete halfway through.
  // Why long paths: creation checks out with them on Windows, so deleting without them fails with
  // "Filename too long" (#6433) and leaves the branch behind via the Windows recovery.
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
    try {
      await gitExecFileAsync(args, execOptions)
    } catch (error) {
      if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
        throw error
      }
      // Why: Git refuses non-force removal of a worktree with an initialised submodule even when clean; re-prove cleanliness, then --force.
      await assertWorktreeCleanForRemoval(worktreePath, false, options)
      await gitExecFileAsync(
        [...longPathArgs, 'worktree', 'remove', '--force', worktreePath],
        execOptions
      )
    }
    await removeCheckoutLeftByGit(worktreePath, options)
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
  // Why its own span: branch cleanup can reach the network (`fetch --prune`), so a stall here reads as
  // `git worktree remove` being slow unless it is timed separately.
  // Why serialized per repo: concurrent removals in one repo race `packed-refs.lock` and the
  // remote-tracking ref locks of `fetch --prune` (#2259); the checkout deletes above need not wait.
  return runKeyedSerializedOperation(branchCleanupQueueByRepo, repoPath, () =>
    withSpan('worktree.remove.branch_delete', () =>
      deleteBranchAfterWorktreeRemoval(repoPath, branchName, branchHead, options)
    )
  )
}

/**
 * Finishes a removal whose checkout Git no longer registers (it finished deleting, or an earlier
 * run did): leftover files, stale admin records, then the branch. Already-gone parts are done.
 */
export async function finishUnregisteredWorktreeRemoval(
  repoPath: string,
  worktreePath: string,
  branch: { name: string; head: string } | null,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  try {
    await runUnderWorktreeDeleteLimit(() => removeCheckoutLeftByGit(worktreePath, options))
    await gitExecFileAsync(['worktree', 'prune'], gitExecOptions(repoPath, options)).catch(
      (error: unknown) => console.warn(`[git] worktree prune failed in ${repoPath}`, error)
    )
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

// Why: Git for Windows runs $GIT_ASK_YESNO when a file stays locked mid-delete; no prompt program may run here.
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

// Why: Git for Windows does not descend into junctions and exits 0 with them and their parent
// directories still on disk; finish the delete Git already accepted instead of leaving it behind.
async function removeCheckoutLeftByGit(
  worktreePath: string,
  options: RemoveWorktreeOptions
): Promise<void> {
  // Why: WSL-owned checkouts are deleted inside the distro, so Node on Windows must not touch them.
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
  await removeHostTree(worktreePath)
}
