import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName
} from '../../../source-control/repo-default-branch'
import type { GhExecOptions, HostedReviewLocalGitOptions } from './../github-exec-scope'
import type { TrackedUpstreamBranch } from './tracked-upstream-cache'
import {
  pullRequestHeadRepository,
  type PullRequestLookupData,
  type PullRequestLookupPolicy
} from './pull-request-lookup-data'
import { getRestPRByNumber } from './pr-number-lookup'

export type ImplicitDefaultBranchPRContext = {
  originHeadRepo: OwnerRepo | null
  trackedUpstream: { branch: TrackedUpstreamBranch; headRepo: OwnerRepo } | null
  branchName: string
  linkedPRNumber?: number | null
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
  ghOptions: GhExecOptions
}

export function createImplicitDefaultBranchPRPolicy(
  context: ImplicitDefaultBranchPRContext
): PullRequestLookupPolicy {
  const rejected = new Set<string>()
  const rejectedPRUrls = new Set<string>()
  return {
    rejectedPRUrls,
    async accepts(data, prRepo) {
      const hidden = await shouldHideImplicitDefaultBranchPR({ ...context, data, prRepo })
      if (hidden && prRepo) {
        rejected.add(`${githubRepoIdentityKey(prRepo)}#${data.number}`)
        if (data.url) {
          rejectedPRUrls.add(data.url)
        }
      }
      return !hidden
    },
    isRejected(prRepo, number) {
      return rejected.has(`${githubRepoIdentityKey(prRepo)}#${number}`)
    }
  }
}

async function shouldHideImplicitDefaultBranchPR(
  input: ImplicitDefaultBranchPRContext & { data: PullRequestLookupData; prRepo: OwnerRepo | null }
): Promise<boolean> {
  const { data, branchName, prRepo } = input
  if (
    !branchName ||
    !data.headRefName ||
    data.headRefName === branchName ||
    typeof input.linkedPRNumber === 'number'
  ) {
    return false
  }
  const headRepo = pullRequestHeadRepository(data, prRepo)
  // Fork heads are real review branches even when their name is a default branch elsewhere.
  if (!headRepo || !prRepo || githubRepoIdentityKey(headRepo) !== githubRepoIdentityKey(prRepo)) {
    return false
  }
  if (data.headDefaultBranchName) {
    return data.headRefName === data.headDefaultBranchName
  }
  const headRepoKey = githubRepoIdentityKey(headRepo)
  const remoteName =
    input.trackedUpstream && githubRepoIdentityKey(input.trackedUpstream.headRepo) === headRepoKey
      ? input.trackedUpstream.branch.remoteName
      : input.originHeadRepo && githubRepoIdentityKey(input.originHeadRepo) === headRepoKey
        ? 'origin'
        : null
  if (!remoteName) {
    try {
      // Removed tracking can leave a cached integration PR without a matching remote.
      const metadata = await getRestPRByNumber(prRepo, data.number, input.ghOptions)
      const metadataHeadRepo = pullRequestHeadRepository(metadata, prRepo)
      return (
        metadataHeadRepo !== null &&
        githubRepoIdentityKey(metadataHeadRepo) === headRepoKey &&
        metadata.headRefName === data.headRefName &&
        metadata.headDefaultBranchName === data.headRefName
      )
    } catch {
      return false
    }
  }
  // An unknown upstream HEAD cannot borrow a different repository's origin default.
  const defaultBranchName =
    remoteName === 'origin'
      ? await getRepoDefaultBranchName(input.repoPath, input.connectionId, input.localGitOptions)
      : await getRemoteHeadBranchName(
          input.repoPath,
          remoteName,
          input.connectionId,
          input.localGitOptions
        )
  return defaultBranchName !== null && data.headRefName === defaultBranchName
}
