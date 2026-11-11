import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { getGitHubApiRepositoryForRemoteUrl } from '../../repositories/github-api-repository-remote-probe'
import type { HostedReviewLocalGitOptions } from './../github-exec-scope'
import { getReviewBranchSource, getTrackedUpstreamBranch } from './tracked-upstream-branch'
import {
  shouldRetryTrackedUpstreamBranch,
  type TrackedUpstreamBranch
} from './tracked-upstream-cache'
import { getGitHubApiRepositoryForRemote } from '../../repositories/github-api-repository-remote-probe'

export type BranchHead = { branch: TrackedUpstreamBranch; headRepo: OwnerRepo }

/**
 * Where a plain `git push` publishes this branch: branch.<name>.pushRemote, remote.pushDefault, a
 * separate pushurl, or a push refspec's destination. Null when config names no single GitHub head.
 */
export async function getConfiguredPushHead(
  repoPath: string,
  branchName: string,
  connectionId: string | null | undefined,
  localGitOptions: HostedReviewLocalGitOptions
): Promise<BranchHead | null> {
  let source: Awaited<ReturnType<typeof getReviewBranchSource>>
  try {
    source = await getReviewBranchSource(repoPath, branchName, connectionId, localGitOptions)
  } catch {
    return null
  }
  const repositories = await Promise.all(
    source.urls.map((url) =>
      getGitHubApiRepositoryForRemoteUrl(repoPath, url, connectionId, localGitOptions)
    )
  )
  const [headRepo] = repositories
  // A remote that pushes to several repositories proves no single head.
  if (
    !headRepo ||
    repositories.some(
      (repository) =>
        !repository || githubRepoIdentityKey(repository) !== githubRepoIdentityKey(headRepo)
    )
  ) {
    return null
  }
  return { branch: { remoteName: source.remoteName, branchName: source.branchName }, headRepo }
}

export function branchHeadKey(repo: OwnerRepo, branchName: string): string {
  return `${githubRepoIdentityKey(repo)}\0${branchName}`
}

/** The branch's %(upstream), when it names a head other than origin's same-named branch. */
export async function getTrackedUpstreamHead(
  repoPath: string,
  branchName: string,
  connectionId: string | null | undefined,
  localGitOptions: HostedReviewLocalGitOptions,
  originHeadRepo: OwnerRepo | null
): Promise<BranchHead | null> {
  const upstreamBranch = await getTrackedUpstreamBranch(
    repoPath,
    branchName,
    connectionId,
    localGitOptions
  )
  if (!upstreamBranch) {
    return null
  }
  const upstreamHeadRepo =
    (await getGitHubApiRepositoryForRemote(
      repoPath,
      upstreamBranch.remoteName,
      connectionId,
      localGitOptions
    )) ?? originHeadRepo
  return upstreamHeadRepo &&
    shouldRetryTrackedUpstreamBranch(upstreamBranch, branchName, upstreamHeadRepo, originHeadRepo)
    ? { branch: upstreamBranch, headRepo: upstreamHeadRepo }
    : null
}
