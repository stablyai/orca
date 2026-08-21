// Fork remotes are removed only after shared ownership and git-config checks.

import type { Store } from '../persistence'
import type { GitPushTarget } from '../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { sameGitHubRemoteUrl } from '../../shared/git-push-target-remote-url'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'
import type { WorktreePushTargetGit } from './worktree-push-target-git'

export type WorktreePushTargetStore = Pick<Store, 'getAllWorktreeMeta'>

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
  git: WorktreePushTargetGit,
  repoPath: string,
  target: GitPushTarget
): Promise<boolean> {
  try {
    const stdout = await git.readBranchRemoteConfig(repoPath)
    // Why: git config output can be large; avoid materializing line/split arrays here.
    for (const line of iterateProcessOutputLines(stdout)) {
      const value = readBranchRemoteConfigValue(line)
      if (value === target.remoteName || value === target.remoteUrl) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

function readBranchRemoteConfigValue(line: string): string | null {
  let index = 0
  while (index < line.length && isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  while (index < line.length && !isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  while (index < line.length && isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  if (index >= line.length) {
    return null
  }

  const valueStart = index
  let valueEnd = line.length
  while (valueEnd > valueStart && isBranchConfigSeparator(line.charCodeAt(valueEnd - 1))) {
    valueEnd -= 1
  }
  return valueStart < valueEnd ? line.slice(valueStart, valueEnd) : null
}

function isBranchConfigSeparator(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

export async function cleanupUnusedWorktreePushTargetRemoteWithGit(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  git: WorktreePushTargetGit
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
  if (await hasBranchConfigUsingRemote(git, repoPath, target)) {
    return
  }

  await git.removeRemoteIfMatches(repoPath, { ...target, remoteUrl: target.remoteUrl })
}
