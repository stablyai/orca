import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const HostedReviewForBranch = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

const HostedReviewCreationEligibility = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  base: z.string().nullable().optional(),
  hasUncommittedChanges: z.boolean().optional(),
  hasUpstream: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

const HostedReviewCreate = z.object({
  repo: requiredString('Missing repo selector'),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'gitea', 'unsupported']),
  base: requiredString('Missing base branch'),
  head: z.string().optional(),
  title: requiredString('Missing title'),
  body: z.string().optional(),
  draft: z.boolean().optional()
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
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
  }),
  defineMethod({
    name: 'hostedReview.getCreationEligibility',
    params: HostedReviewCreationEligibility,
    handler: async (params, { runtime }) =>
      runtime.getHostedReviewCreationEligibility({
        repoSelector: params.repo,
        branch: params.branch,
        base: params.base ?? null,
        hasUncommittedChanges: params.hasUncommittedChanges,
        hasUpstream: params.hasUpstream,
        ahead: params.ahead,
        behind: params.behind,
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
  }),
  defineMethod({
    name: 'hostedReview.create',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) =>
      runtime.createHostedReview({
        repoSelector: params.repo,
        provider: params.provider,
        base: params.base,
        head: params.head,
        title: params.title,
        body: params.body,
        draft: params.draft
      })
  })
]
