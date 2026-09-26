import {
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  getBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import { isBranchCheckedOutInWorktreeError } from '../../shared/git-branch-delete-refusal'
import {
  BranchDeletionUnverifiedError,
  verifyDeletedBranchCheckout
} from '../../shared/git-branch-delete-verification'
import type { GitWorktreeExecOptions, RemoveWorktreeOptions } from './worktree-operation-options'
import { gitExecOptions, normalizeLocalBranchRef } from './worktree-operation-options'

export async function deleteBranchAfterWorktreeRemoval(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: RemoveWorktreeOptions
): Promise<RemoveWorktreeResult> {
  try {
    if (options.forceBranchDelete) {
      await forceDeleteBranchAfterRollback(repoPath, branchName, options)
      return {}
    }
    if (
      branchHead &&
      (await deleteMergedBranchAfterWorktreeRemoval(repoPath, branchName, branchHead, options))
    ) {
      return {}
    }
  } catch (error) {
    if (error instanceof BranchDeletionUnverifiedError) {
      throw error
    }
    // Removal already succeeded; a failed or raced proof must preserve the branch.
    console.warn(`[git] Preserved local branch "${branchName}" after removing worktree`, error)
  }
  return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
}

async function forceDeleteBranchAfterRollback(
  repoPath: string,
  branchName: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await gitExecFileAsync(['branch', '-D', '--', branchName], gitExecOptions(repoPath, options))
    return
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    // Prune only when a stale checkout registration may block rollback.
    await gitExecFileAsync(['worktree', 'prune'], gitExecOptions(repoPath, options))
  } catch (error) {
    console.warn(`[git] Failed to prune worktrees before deleting branch "${branchName}"`, error)
    return
  }

  try {
    await gitExecFileAsync(['branch', '-D', '--', branchName], gitExecOptions(repoPath, options))
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return
    }
    throw error
  }
}

async function deleteMergedBranchAfterWorktreeRemoval(
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
  // A tracking branch proves publication, not integration into the base.
  const hasNoUnmergedChanges = await withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      branchHasNoUnmergedChangesWithLazyTargetRefresh(
        runGit,
        branchName,
        targetRefs,
        capabilities,
        branchHead
      )
  )
  if (!hasNoUnmergedChanges) {
    return false
  }
  await forceDeleteLocalBranch(
    repoPath,
    branchName,
    branchHead,
    (args, cwd) => gitExecFileAsync(args, gitExecOptions(cwd, options)),
    { pruneStaleWorktrees: true }
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
  ) => gitExecFileAsync(args, { cwd }),
  options: { pruneStaleWorktrees?: boolean } = {}
): Promise<void> {
  if (!branchName || branchName.includes('\0')) {
    throw new Error('Invalid branch name')
  }
  if (!expectedHead) {
    throw new Error(
      `Cannot force-delete local branch "${branchName}" without the commit Git preserved.`
    )
  }
  let checkedOut = await isLocalBranchCheckedOut(repoPath, branchName, runGit)
  if (checkedOut && options.pruneStaleWorktrees) {
    await runGit(['worktree', 'prune'], repoPath)
    checkedOut = await isLocalBranchCheckedOut(repoPath, branchName, runGit)
  }
  if (checkedOut) {
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
  await verifyDeletedBranchCheckout(
    branchName,
    () => isLocalBranchCheckedOut(repoPath, branchName, runGit),
    () => runGit(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
  )
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
