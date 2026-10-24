import {
  getBitbucketPullRequest,
  getBitbucketPullRequestForBranchOrThrow,
  getBitbucketRepoSlug
} from '../bitbucket/client'
import { createBitbucketPullRequest } from '../bitbucket/pull-request-creation'
import {
  getBitbucketServerPullRequest,
  getBitbucketServerPullRequestForBranchOrThrow
} from '../bitbucket/server-client'
import { createBitbucketServerPullRequest } from '../bitbucket/server-pull-request-creation'
import { getBitbucketServerRepoRef } from '../bitbucket/server-repository-ref'
import type { ForgeProvider, ForgeProviderRepositoryContext } from './forge-provider'
import { forgeConnectionId, hostedReviewExecutionArgs } from './forge-provider-execution'
import { mapBitbucketReview } from './forge-review-mappers'
import { getHostedReviewLocalGitOptions } from './hosted-review-git-options'

function bitbucketServerRepoRef(context: ForgeProviderRepositoryContext) {
  return getBitbucketServerRepoRef(
    context.repoPath,
    forgeConnectionId(context),
    getHostedReviewLocalGitOptions(context)
  )
}

// Why: one provider id serves Cloud and Server; a registered Server host wins, everything else stays on Cloud.
export const bitbucketForgeProvider = {
  id: 'bitbucket',
  supportsReviewCreation: true,
  async resolveRepository(context) {
    return (
      (await bitbucketServerRepoRef(context)) ??
      getBitbucketRepoSlug(
        context.repoPath,
        forgeConnectionId(context),
        ...hostedReviewExecutionArgs(context)
      )
    )
  },
  async getReviewForBranch(input) {
    const lookup = (await bitbucketServerRepoRef(input))
      ? getBitbucketServerPullRequestForBranchOrThrow
      : getBitbucketPullRequestForBranchOrThrow
    // Why: surface a real lookup failure so eligibility records `unavailable`
    // instead of a false "No pull request found".
    const pr = await lookup(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  async getReviewByNumber(input) {
    const lookup = (await bitbucketServerRepoRef(input))
      ? getBitbucketServerPullRequest
      : getBitbucketPullRequest
    const pr = await lookup(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  async createReview(...args: Parameters<NonNullable<ForgeProvider['createReview']>>) {
    const [repoPath, , executionHostId, options] = args
    const create = (await bitbucketServerRepoRef({ repoPath, executionHostId, ...options }))
      ? createBitbucketServerPullRequest
      : createBitbucketPullRequest
    return create(...args)
  }
} satisfies ForgeProvider
