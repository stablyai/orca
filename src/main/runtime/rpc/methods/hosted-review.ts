import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const HostedReviewForBranch = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional()
})

export const HOSTED_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'hostedReview.forBranch',
    params: HostedReviewForBranch,
    handler: async (params, { runtime }) =>
      runtime.getHostedReviewForBranch({
        repoSelector: params.repo,
        branch: params.branch,
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null
      })
  })
]
