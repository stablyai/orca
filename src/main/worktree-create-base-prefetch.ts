import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/types'
import { hasLocalCommitObject } from './git/commit-object-ref'
import { getDefaultBaseRef } from './git/repo'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { prefetchRemoteWorktreeCreateBase } from './ipc/worktree-remote'

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
  getOrStartRemoteTrackingBaseRefresh: (
    repoPath: string,
    base: RemoteTrackingBaseForPrefetch
  ) => Promise<unknown>
  fetchRemoteWithCache: (repoPath: string, remote: string) => Promise<void>
}

function getFallbackRemoteForBase(baseBranch: string): string {
  return baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
}

async function prefetchLocalWorktreeCreateBase(
  repo: Repo,
  baseBranch: string | undefined,
  runtime: WorktreeCreateBasePrefetchRuntime
): Promise<void> {
  const resolvedBaseBranch = baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
  if (!resolvedBaseBranch) {
    return
  }
  if (await hasLocalCommitObject(repo.path, resolvedBaseBranch)) {
    // Why: hosted-review start points can be verified commit SHAs; a broad
    // remote fetch cannot make an already-local object fresher.
    return
  }
  const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(repo.path, resolvedBaseBranch)
  if (remoteTrackingBase) {
    await runtime.getOrStartRemoteTrackingBaseRefresh(repo.path, remoteTrackingBase)
    return
  }

  // Why: keep optimistic prefetch on the same best-effort fallback path as
  // create so the real create can reuse the runtime's remote fetch cache.
  await runtime.fetchRemoteWithCache(repo.path, getFallbackRemoteForBase(resolvedBaseBranch))
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
