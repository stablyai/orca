// Why: preparing a fork-PR push target means adding (or reusing) the contributor's
// fork as a git remote, fetching the head, and wiring the new branch's upstream.
// The git-driven core lives here behind an injectable `execGit` seam so the
// remote-reuse / unique-naming / fetch behavior is unit-testable without a real
// repo. The store-aware ownership decision stays with the caller via a predicate.

import type { GitPushTarget } from '../../shared/types'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import type { GitRemoteExec } from './worktree-push-target-cleanup'

export async function findRemoteForUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await execGit(['remote'], repoPath)
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await execGit(['remote', 'get-url', remote], repoPath)
        const candidateUrl = urlStdout.trim()
        const candidate = parseGitHubOwnerRepo(candidateUrl)
        if (
          target &&
          candidate &&
          target.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          target.repo.toLowerCase() === candidate.repo.toLowerCase()
        ) {
          return remote
        }
        if (candidateUrl === remoteUrl) {
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
  execGit: GitRemoteExec,
  repoPath: string,
  preferred: string
): Promise<string> {
  const { stdout } = await execGit(['remote'], repoPath)
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

// Exported for unit tests: the `execGit` seam drives the remote add/reuse/fetch
// behavior without a real repo. `isRemoteCreatedByKnownWorktree` lets the caller
// inject the store-aware ownership decision for the reuse case.
export async function prepareWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  isRemoteCreatedByKnownWorktree: (existingRemote: string) => boolean
): Promise<GitPushTarget> {
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = isRemoteCreatedByKnownWorktree(existingRemote)
    } else {
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      await execGit(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      remoteCreated = true
    }
  }

  await execGit(
    [
      'fetch',
      remoteName,
      `+refs/heads/${target.branchName}:refs/remotes/${remoteName}/${target.branchName}`
    ],
    repoPath
  )
  return {
    ...sanitizedTarget,
    remoteName,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

export async function configureCreatedWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await execGit(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
  return target
}
