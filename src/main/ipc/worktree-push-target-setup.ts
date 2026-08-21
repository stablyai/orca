// The typed git boundary keeps local and SSH push-target setup on one workflow.

import type { GitPushTarget } from '../../shared/worktree/types'
import { sameGitHubRemoteUrl } from '../../shared/git-push-target-remote-url'
import { MAX_GIT_REMOTE_NAME_LENGTH } from '../../shared/git-push-target-validation'
import type { WorktreePushTargetGit } from './worktree-push-target-git'

export async function findRemoteForUrl(
  git: WorktreePushTargetGit,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    for (const remote of await git.listRemotes(repoPath)) {
      try {
        if (sameGitHubRemoteUrl(await git.getRemoteUrl(repoPath, remote), remoteUrl)) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

export async function ensureUniqueRemoteName(
  git: WorktreePushTargetGit,
  repoPath: string,
  preferred: string
): Promise<string> {
  const existing = new Set(await git.listRemotes(repoPath))
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const suffixText = `-${suffix}`
    const maxBaseLength = MAX_GIT_REMOTE_NAME_LENGTH - suffixText.length
    const candidate = `${preferred.slice(0, maxBaseLength).replace(/\/$/, '')}${suffixText}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

export async function prepareWorktreePushTargetWithGit(
  git: WorktreePushTargetGit,
  repoPath: string,
  target: GitPushTarget,
  isRemoteCreatedByKnownWorktree: (existingRemote: string) => boolean,
  onRemoteAdded?: (addedRemote: GitPushTarget & { remoteUrl: string }) => void
): Promise<GitPushTarget> {
  await git.validateTarget(repoPath, target)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  let addedRemote: (GitPushTarget & { remoteUrl: string }) | undefined
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(git, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = isRemoteCreatedByKnownWorktree(existingRemote)
    } else {
      remoteName = await ensureUniqueRemoteName(git, repoPath, target.remoteName)
      await git.addRemote(repoPath, { ...sanitizedTarget, remoteName, remoteUrl: target.remoteUrl })
      remoteCreated = true
      addedRemote = { ...sanitizedTarget, remoteName, remoteUrl: target.remoteUrl }
      onRemoteAdded?.(addedRemote)
    }
  }

  const preparedTarget = { ...sanitizedTarget, remoteName }
  try {
    await git.fetchRemoteTrackingRef(repoPath, preparedTarget)
  } catch (error) {
    if (addedRemote) {
      try {
        await git.removeRemoteIfMatches(repoPath, addedRemote)
      } catch {
        // Preserve the fetch error when best-effort cleanup fails.
      }
    }
    throw error
  }
  return {
    ...preparedTarget,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

export async function configureCreatedWorktreePushTargetWithGit(
  git: WorktreePushTargetGit,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await git.configureUpstream(worktreePath, branchName, target)
  return target
}
