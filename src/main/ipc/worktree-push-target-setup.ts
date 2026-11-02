import type { GitPushTarget } from '../../shared/worktree/types'
import { findGitRemoteNameByFetchUrl } from '../../shared/git-remote-url-index'
import { getGitCurrentBranchName } from '../../shared/git-current-branch'
import { sameGitHubRemoteUrl, type GitRemoteExec } from './worktree-push-target-cleanup'
import {
  buildNarrowForkFetchRefspec,
  ensureRemoteTracksBranchNarrowly
} from '../git/fork-remote-refspec'

// One remote -v avoids a subprocess per configured remote (#17914).
export async function findRemoteForUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    const { stdout } = await execGit(['remote', '-v'], repoPath)
    return findGitRemoteNameByFetchUrl(stdout, (candidateUrl) =>
      sameGitHubRemoteUrl(candidateUrl, remoteUrl)
    )
  } catch {
    return null
  }
}

// Named-remote probes keep repeated materialization independent of remote-table size.
export async function remoteAlreadyMatchesUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteName: string,
  remoteUrl: string
): Promise<boolean> {
  try {
    const { stdout } = await execGit(['remote', 'get-url', remoteName], repoPath)
    return sameGitHubRemoteUrl(stdout.trim(), remoteUrl)
  } catch {
    return false
  }
}

// Deferred materialization still needs upstream; resolve local HEAD because collision-renamed branches differ from the PR head.
export async function resolveCheckedOutBranchName(
  execGit: GitRemoteExec,
  repoPath: string
): Promise<string | null> {
  return getGitCurrentBranchName((args) => execGit(args, repoPath))
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

export async function prepareWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  isRemoteCreatedByKnownWorktree: (existingRemote: string) => boolean
): Promise<GitPushTarget> {
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  // Inherited ownership is not proof this call created the remote; only new additions may roll back.
  let remoteAddedHere = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Reused Orca remotes retain ownership so removing the final worktree can reclaim them.
      remoteCreated = isRemoteCreatedByKnownWorktree(existingRemote)
      // Reused remotes may still track every fork branch; keep this branch within the bounded refspec.
      await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, target.branchName)
    } else {
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      // Restrict branches and tags at creation so even transient config cannot import the whole fork.
      await execGit(
        ['remote', 'add', '-t', target.branchName, '--no-tags', remoteName, target.remoteUrl],
        repoPath
      )
      remoteAddedHere = true
      try {
        // Rewrite -t's literal refspec to the trailing-* form that tolerates deleted branches.
        await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, target.branchName)
        // Git config provenance survives store purge and is removed with the remote.
        await execGit(['config', `remote.${remoteName}.orca-created`, 'true'], repoPath)
      } catch (error) {
        // Failed provenance setup must roll back or cleanup cannot reclaim the half-configured remote.
        await execGit(['remote', 'remove', remoteName], repoPath).catch(() => {})
        throw error
      }
      remoteCreated = true
    }
  }

  try {
    await execGit(
      ['fetch', remoteName, buildNarrowForkFetchRefspec(remoteName, target.branchName)],
      repoPath
    )
  } catch (error) {
    // Failed creation has no future removal event; roll back only this call's remote, preserving reused siblings.
    if (remoteAddedHere) {
      await execGit(['remote', 'remove', remoteName], repoPath).catch(() => {})
    }
    throw error
  }
  return {
    ...sanitizedTarget,
    remoteName,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

// Every materialization path, including reuse, needs this local branch's upstream; PR head and local HEAD can differ.
export async function restoreUpstreamAfterMaterialize(
  execGit: GitRemoteExec,
  worktreePath: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  if (!target.remoteUrl) {
    return target
  }
  const checkedOutBranch = await resolveCheckedOutBranchName(execGit, worktreePath)
  if (!checkedOutBranch) {
    return target
  }
  return configureCreatedWorktreePushTargetWithExec(execGit, worktreePath, checkedOutBranch, target)
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
