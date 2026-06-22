import {
  branchHasNoUnmergedChangesOnAnyTarget,
  getBranchCleanupTargetRefs,
  refreshBranchCleanupTargetRefs
} from '../shared/git-branch-cleanup'
import type { GitExec } from './git-handler-ops'
import { parseWorktreeList } from './git-handler-utils'

export async function deleteAlreadyMergedRelayBranchAfterSafeDeleteFailure(
  git: GitExec,
  repoPath: string,
  branchName: string,
  branchHead: string
): Promise<boolean> {
  const runGit = (args: string[], options?: { stdin?: string }) =>
    options ? git(args, repoPath, options) : git(args, repoPath)
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  await refreshBranchCleanupTargetRefs(runGit, targetRefs)
  // Why: SSH worktrees hit the same squash-merge shape as local worktrees.
  // Git's no-op merge proof lets us clean up only branches whose changes
  // already exist on the saved base ref.
  if (!(await branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, targetRefs))) {
    return false
  }
  await deleteRelayBranchAtExpectedHead(git, repoPath, branchName, branchHead)
  return true
}

async function deleteRelayBranchAtExpectedHead(
  git: GitExec,
  repoPath: string,
  branchName: string,
  expectedHead: string
): Promise<void> {
  if (await isRelayBranchCheckedOut(git, repoPath, branchName)) {
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  await git(['update-ref', '-d', `refs/heads/${branchName}`, expectedHead], repoPath)
  if (await isRelayBranchCheckedOut(git, repoPath, branchName)) {
    try {
      await git(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
    } catch (restoreError) {
      console.warn(
        `relay removeWorktree: failed to restore local branch "${branchName}" after concurrent checkout`,
        restoreError
      )
    }
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
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
