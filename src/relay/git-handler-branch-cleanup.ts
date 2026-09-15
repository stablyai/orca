import {
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  getBranchCleanupTargetRefs
} from '../shared/git-branch-cleanup'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import type { GitExec } from './git-handler-ops'
import { parseWorktreeList } from '../shared/git-worktree-porcelain-parser'
import { verifyDeletedBranchCheckout } from '../shared/git-branch-delete-verification'

export async function deleteMergedRelayBranchAfterWorktreeRemoval(
  git: GitExec,
  repoPath: string,
  branchName: string,
  branchHead: string,
  capabilities: GitCapabilityCache
): Promise<boolean> {
  const runGit = (args: string[], options?: { stdin?: string }) =>
    options ? git(args, repoPath, options) : git(args, repoPath)
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  // A tracking branch proves publication, not integration into the base.
  if (
    !(await branchHasNoUnmergedChangesWithLazyTargetRefresh(
      runGit,
      branchName,
      targetRefs,
      capabilities,
      branchHead
    ))
  ) {
    return false
  }
  await deleteRelayBranchAtExpectedHead(git, repoPath, branchName, branchHead, {
    pruneStaleWorktrees: true
  })
  return true
}

export async function forceDeletePreservedRelayBranch(
  git: GitExec,
  repoPath: string,
  branchName: string,
  expectedHead: string
): Promise<void> {
  if (!branchName || branchName.includes('\0') || branchName.startsWith('-')) {
    throw new Error('Invalid branch name for preserved branch delete.')
  }
  if (!expectedHead) {
    throw new Error('Expected branch head is required for preserved branch delete.')
  }
  await deleteRelayBranchAtExpectedHead(git, repoPath, branchName, expectedHead, {
    mapUpdateRefError: () =>
      new Error(
        `Local branch "${branchName}" changed after the workspace was deleted. Review it before deleting it.`
      )
  })
}

async function deleteRelayBranchAtExpectedHead(
  git: GitExec,
  repoPath: string,
  branchName: string,
  expectedHead: string,
  options: {
    mapUpdateRefError?: (error: unknown) => Error
    pruneStaleWorktrees?: boolean
  } = {}
): Promise<void> {
  let checkedOut = await isRelayBranchCheckedOut(git, repoPath, branchName)
  if (checkedOut && options.pruneStaleWorktrees) {
    await git(['worktree', 'prune'], repoPath)
    checkedOut = await isRelayBranchCheckedOut(git, repoPath, branchName)
  }
  if (checkedOut) {
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  try {
    await git(['update-ref', '-d', `refs/heads/${branchName}`, expectedHead], repoPath)
  } catch (error) {
    // Why: only stale ref writes get the force-delete message; checkout guards
    // and removeWorktree cleanup still rely on their distinct/raw failures.
    throw options.mapUpdateRefError?.(error) ?? error
  }
  await verifyDeletedBranchCheckout(
    branchName,
    () => isRelayBranchCheckedOut(git, repoPath, branchName),
    () => git(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
  )
  try {
    await git(['config', '--remove-section', `branch.${branchName}`], repoPath)
  } catch {
    // Best-effort parity with `git branch -D`; stale config is harmless after
    // the expected ref was deleted.
  }
}

async function isRelayBranchCheckedOut(
  git: GitExec,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreeList(stdout).some(
    (worktree) =>
      typeof worktree.branch === 'string' &&
      worktree.branch.replace(/^refs\/heads\//, '') === branchName
  )
}
