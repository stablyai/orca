import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName
} from '../../../source-control/repo-default-branch'
import type { HostedReviewLocalGitOptions } from './../github-exec-scope'
import type { TrackedUpstreamBranch } from './tracked-upstream-cache'

/**
 * #26948: `git switch -c x origin/develop` makes a branch track the default
 * branch, whose PRs (e.g. develop -> release) belong to that branch, not this one.
 * A same-named branch on a fork outside the PR candidates is a real head, so it stays.
 */
export async function isTrackedUpstreamDefaultBranch(input: {
  upstreamBranch: TrackedUpstreamBranch
  upstreamHeadRepo: OwnerRepo
  candidates: OwnerRepo[]
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
}): Promise<boolean> {
  const upstreamRepoKey = githubRepoIdentityKey(input.upstreamHeadRepo)
  if (!input.candidates.some((candidate) => githubRepoIdentityKey(candidate) === upstreamRepoKey)) {
    return false
  }
  const { remoteName } = input.upstreamBranch
  // Why: a fork's `upstream` can default to a different branch than `origin`; use origin's only when the remote never recorded its HEAD.
  const remoteDefaultBranchName =
    remoteName === 'origin'
      ? null
      : await getRemoteHeadBranchName(
          input.repoPath,
          remoteName,
          input.connectionId,
          input.localGitOptions
        )
  const defaultBranchName =
    remoteDefaultBranchName ??
    (await getRepoDefaultBranchName(input.repoPath, input.connectionId, input.localGitOptions))
  return defaultBranchName === input.upstreamBranch.branchName
}
