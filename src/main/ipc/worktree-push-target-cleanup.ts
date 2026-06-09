// Why: fork-PR worktrees can add a contributor's fork as a git remote. When such
// a worktree is deleted we prune that remote, but only when it's truly unused.
// This module holds that decision logic behind an injectable `execGit` boundary so
// the multi-fork cleanup matrix is unit-testable without a real repo.

import type { Store } from '../persistence'
import type { GitPushTarget } from '../../shared/types'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'

export type GitRemoteExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
export type WorktreePushTargetStore = Pick<Store, 'getAllWorktreeMeta'>

export function sameGitHubRemoteUrl(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const parsedLeft = parseGitHubOwnerRepo(left)
  const parsedRight = parseGitHubOwnerRepo(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.owner.toLowerCase() === parsedRight.owner.toLowerCase() &&
    parsedLeft.repo.toLowerCase() === parsedRight.repo.toLowerCase()
  )
}

function isPushTargetUsedByAnotherWorktree(
  store: WorktreePushTargetStore,
  removedWorktreeId: string,
  target: GitPushTarget
): boolean {
  const removedRepoId = getRepoIdFromWorktreeId(removedWorktreeId)
  return Object.entries(store.getAllWorktreeMeta()).some(([worktreeId, meta]) => {
    // Why: git remotes are repo-local; matching metadata from another repo
    // must not pin this repo's fork remote forever.
    const belongsToSameRepo = getRepoIdFromWorktreeId(worktreeId) === removedRepoId
    if (worktreeId === removedWorktreeId || !belongsToSameRepo || !meta.pushTarget) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

async function hasBranchConfigUsingRemote(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget
): Promise<boolean> {
  try {
    const { stdout } = await execGit(
      ['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'],
      repoPath
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const value = line.split(/\s+/).slice(1).join(' ')
        return value === target.remoteName || value === target.remoteUrl
      })
  } catch {
    return false
  }
}

// Exported for unit tests: the `execGit` seam lets tests drive the multi-fork
// cleanup matrix without touching a real repo.
export async function cleanupUnusedWorktreePushTargetRemoteWithExec(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec
): Promise<void> {
  if (
    !target?.remoteCreated ||
    !target.remoteUrl ||
    target.remoteName === 'origin' ||
    target.remoteName === 'upstream'
  ) {
    return
  }
  if (isPushTargetUsedByAnotherWorktree(store, removedWorktreeId, target)) {
    return
  }
  if (await hasBranchConfigUsingRemote(execGit, repoPath, target)) {
    return
  }

  let configuredRemoteUrl: string
  try {
    configuredRemoteUrl = (
      await execGit(['remote', 'get-url', target.remoteName], repoPath)
    ).stdout.trim()
  } catch {
    return
  }
  if (!sameGitHubRemoteUrl(configuredRemoteUrl, target.remoteUrl)) {
    return
  }

  await execGit(['remote', 'remove', target.remoteName], repoPath)
}
