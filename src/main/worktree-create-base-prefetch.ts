import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/types'
import { hasLocalCommitObject, isFullGitObjectId } from './git/commit-object-ref'
import { hasWorktreeBaseCommitRef } from './git/worktree-base-ref-probe'
import { getDefaultBaseRef } from './git/repo'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { prefetchRemoteWorktreeCreateBase } from './ipc/worktree-remote'
import { resolveWorktreeCreateBase } from './worktree-create-base'
import { resolveWorktreeAddBaseRef } from '../shared/worktree-base-ref'

type RemoteTrackingBaseForPrefetch = {
  remote: string
  branch: string
  ref: string
  base: string
}

type WorktreeCreateBasePrefetchRuntime = {
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string
  ) => Promise<RemoteTrackingBaseForPrefetch | null>
  hasRemoteTrackingRef: (repoPath: string, base: RemoteTrackingBaseForPrefetch) => Promise<boolean>
  getOrStartRemoteTrackingBaseRefresh: (
    repoPath: string,
    base: RemoteTrackingBaseForPrefetch
  ) => Promise<unknown>
  fetchRemoteWithCache: (repoPath: string, remote: string) => Promise<void>
}

async function hasLocalWorktreeBaseRef(repoPath: string, baseRef: string): Promise<boolean> {
  const refExists = (qualifiedRef: string) => hasWorktreeBaseCommitRef(repoPath, qualifiedRef)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasLocalCommitObject(repoPath, baseRef)
}

async function prefetchLocalWorktreeCreateBase(
  repo: Repo,
  baseBranch: string | undefined,
  runtime: WorktreeCreateBasePrefetchRuntime
): Promise<void> {
  const resolvedBaseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch: baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: async () => getDefaultBaseRef(repo.path),
    isBaseUsable: async (baseBranchCandidate) => {
      const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
        repo.path,
        baseBranchCandidate
      )
      if (remoteTrackingBase) {
        if (await runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase)) {
          return true
        }
        return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate)
      }
      return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate)
    }
  })
  if (!resolvedBaseBranch) {
    return
  }
  if (
    isFullGitObjectId(resolvedBaseBranch) &&
    (await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch))
  ) {
    return
  }
  const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(repo.path, resolvedBaseBranch)
  if (remoteTrackingBase) {
    if (
      (await runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase)) ||
      !(await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch))
    ) {
      await runtime.getOrStartRemoteTrackingBaseRefresh(repo.path, remoteTrackingBase)
      return
    }
  }
  if (await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch)) {
    // Why: hosted-review start points and local branch bases are already local; a broad remote fetch cannot make them fresher.
    return
  }

  // Why: keep optimistic prefetch on the same best-effort fallback path as
  // create so the real create can reuse the runtime's remote fetch cache.
  await runtime.fetchRemoteWithCache(repo.path, 'origin')
}

export async function prefetchWorktreeCreateBase(args: {
  repo: Repo
  baseBranch?: string
  runtime: WorktreeCreateBasePrefetchRuntime
}): Promise<void> {
  if (isFolderRepo(args.repo)) {
    return
  }
  if (args.repo.connectionId) {
    const provider = getSshGitProvider(args.repo.connectionId)
    if (!provider) {
      return
    }
    await prefetchRemoteWorktreeCreateBase(provider, args.repo, { baseBranch: args.baseBranch })
    return
  }
  await prefetchLocalWorktreeCreateBase(args.repo, args.baseBranch, args.runtime)
}
