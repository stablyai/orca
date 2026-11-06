import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getRemoteHeadBranchName,
  getRepoDefaultBranchName
} from '../../../source-control/repo-default-branch'
import type { GhExecOptions, HostedReviewLocalGitOptions } from './../github-exec-scope'
import { ownerRepoFromPullRequestUrl } from './../github-exec-scope'
import type { TrackedUpstreamBranch } from './tracked-upstream-cache'
import {
  pullRequestHeadRepository,
  pullRequestMatchesHeadRepository,
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
  const rejected = new Map<string, { data: PullRequestLookupData; prRepo: OwnerRepo }>()
  // Tracking can identify a fork after branch discovery rejected it without head evidence.
  const remainsRejected = (data: PullRequestLookupData, prRepo: OwnerRepo): boolean =>
    data.headRefName !== context.branchName || isForeignSameNamedHead(context, data, prRepo)
  return {
    get rejectedPRUrls() {
      return new Set(
        [...rejected.values()]
          .filter(({ data, prRepo }) => remainsRejected(data, prRepo))
          .map(({ data }) => data.url)
          .filter(Boolean)
      )
    },
    async accepts(data, prRepo) {
      const hidden =
        isForeignSameNamedHead(context, data, prRepo) ||
        (await shouldHideImplicitDefaultBranchPR({ ...context, data, prRepo }))
      if (hidden) {
        const rejectedRepo = prRepo ?? ownerRepoFromPullRequestUrl(data.url)
        if (rejectedRepo) {
          rejected.set(`${githubRepoIdentityKey(rejectedRepo)}#${data.number}`, {
            data,
            prRepo: rejectedRepo
          })
        }
      }
      return !hidden
    },
    isRejected(prRepo, number) {
      const entry = rejected.get(`${githubRepoIdentityKey(prRepo)}#${number}`)
      return Boolean(entry && remainsRejected(entry.data, entry.prRepo))
    }
  }
}

// Cached numbers must not revive a foreign head rejected by branch discovery.
function isForeignSameNamedHead(
  context: ImplicitDefaultBranchPRContext,
  data: PullRequestLookupData,
  prRepo: OwnerRepo | null
): boolean {
  const expectedHeads = [context.originHeadRepo, context.trackedUpstream?.headRepo].filter(
    (head) => head != null
  )
  if (data.headRefName !== context.branchName) {
    return false
  }
  return (expectedHeads.length > 0 ? expectedHeads : [null]).every(
    (head) => !pullRequestMatchesHeadRepository(data, prRepo, head)
  )
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
