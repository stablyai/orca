import {
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  getBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { GitWorktreeExecOptions, RemoveWorktreeOptions } from './worktree-operation-options'
import {
  gitExecOptions,
  isBranchCheckedOutInWorktreeError,
  normalizeLocalBranchRef
} from './worktree-operation-options'

export async function deleteBranchAfterWorktreeRemoval(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: RemoveWorktreeOptions
): Promise<RemoveWorktreeResult> {
  try {
    // Why: also drop the now-orphaned branch so delete-worktree leaves none; `-d` (not `-D`) preserves
    // unmerged work, and forceBranchDelete opts into `-D` for failed-creation rollback.
    const branchDeleteResult = await deleteLocalBranchAfterWorktreeRemoval(
      repoPath,
      branchName,
      options.forceBranchDelete === true,
      options
    )
    if (branchDeleteResult === 'checked-out') {
      return {}
    }
    return {}
  } catch (error) {
    if (!options.forceBranchDelete && branchHead) {
      try {
        if (
          await deleteAlreadyMergedBranchAfterSafeDeleteFailure(
            repoPath,
            branchName,
            branchHead,
            options
          )
        ) {
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        // Why: worktree is already gone; a raced branch cleanup should degrade to preserved-branch recovery, not fail delete.
        console.warn(
          `[git] Failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    // Keep an unmerged/unpublished branch: deleting a worktree must never silently discard commits.
    console.warn(
      `[git] Preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

async function deleteLocalBranchAfterWorktreeRemoval(
  repoPath: string,
  branchName: string,
  forceBranchDelete: boolean,
  options: GitWorktreeExecOptions = {}
): Promise<'deleted' | 'checked-out'> {
  const deleteFlag = forceBranchDelete ? '-D' : '-d'
  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    // Why: only pay for `worktree prune` when a stale admin record may be blocking `branch -d`.
    await gitExecFileAsync(['worktree', 'prune'], gitExecOptions(repoPath, options))
  } catch (error) {
    console.warn(`[git] Failed to prune worktrees before deleting branch "${branchName}"`, error)
    return 'checked-out'
  }

  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return 'checked-out'
    }
    throw error
  }
}

async function deleteAlreadyMergedBranchAfterSafeDeleteFailure(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: GitWorktreeExecOptions = {}
): Promise<boolean> {
  const runGit = (args: string[], execOptions?: { stdin?: string }) =>
    gitExecFileAsync(args, {
      ...gitExecOptions(repoPath, options),
      ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {})
    })
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  // Why: squash merges rewrite commit IDs, so `branch -d` rejects already-merged branches; delete only when Git proves no unmerged tree changes.
  const hasNoUnmergedChanges = await withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      branchHasNoUnmergedChangesWithLazyTargetRefresh(runGit, branchName, targetRefs, capabilities)
  )
  if (!hasNoUnmergedChanges) {
    return false
  }
  await forceDeleteLocalBranch(repoPath, branchName, branchHead, (args, cwd) =>
    gitExecFileAsync(args, gitExecOptions(cwd, options))
  )
  return true
}

export async function forceDeleteLocalBranch(
  repoPath: string,
  branchName: string,
  expectedHead: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }> = (
    args,
    cwd
  ) => gitExecFileAsync(args, { cwd })
): Promise<void> {
  if (!branchName || branchName.includes('\0')) {
    throw new Error('Invalid branch name')
  }
  if (!expectedHead) {
    throw new Error(
      `Cannot force-delete local branch "${branchName}" without the commit Git preserved.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  // Why: stale toast actions must not delete a branch that moved; `update-ref -d` deletes only if the ref still == expectedHead.
  try {
    // `update-ref -d` needs the packed-refs lock a running idle pack holds while
    // it rewrites; waits it out rather than cancelling the pack.
    await withRepoRefMaintenancePaused('branch-delete', () =>
      runGit(['update-ref', '-d', `refs/heads/${branchName}`, expectedHead], repoPath)
    )
  } catch {
    throw new Error(
      `Local branch "${branchName}" changed after the workspace was deleted. Review it before deleting it.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    try {
      await runGit(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
    } catch (restoreError) {
      console.warn(
        `[git] Failed to restore local branch "${branchName}" after concurrent checkout`,
        restoreError
      )
    }
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  try {
    await runGit(['config', '--remove-section', `branch.${branchName}`], repoPath)
  } catch {
    // Best-effort parity with `git branch -D`; stale config is harmless.
  }
}

async function isLocalBranchCheckedOut(
  repoPath: string,
  branchName: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<boolean> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreeList(stdout).some(
    (worktree) => normalizeLocalBranchRef(worktree.branch) === branchName
  )
}
