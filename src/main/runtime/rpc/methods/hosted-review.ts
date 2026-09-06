import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { OptionalGitAdmissionTier } from './git-admission-tier-schema'

const HostedReviewForBranch = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  admissionTier: OptionalGitAdmissionTier,
  currentHeadOid: z.string().nullable().optional(),
  // Only the caller's selected worktree; the host caps how many earn the fast tier.
  active: z.boolean().optional(),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  fallbackGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedAzureDevOpsPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

const HostedReviewCreationEligibility = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: z.string().min(1, 'Missing worktree selector').optional(),
  branch: requiredString('Missing branch'),
  base: z.string().nullable().optional(),
  hasUncommittedChanges: z.boolean().optional(),
  hasUpstream: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  fallbackGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedAzureDevOpsPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

const HostedReviewCreate = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: z.string().min(1, 'Missing worktree selector').optional(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'unsupported']),
  base: requiredString('Missing base branch'),
  head: z.string().optional(),
  title: requiredString('Missing title'),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  useTemplate: z.boolean().optional()
})

const ReviewSubmissionHead = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
const ReviewSubmissionPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRelativePath, 'Invalid review path')
const ReviewSubmissionComment = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    path: ReviewSubmissionPath,
    oldPath: ReviewSubmissionPath.optional(),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()
  .refine(
    (comment) => comment.startLine === undefined || comment.startLine <= comment.line,
    'Invalid review line range'
  )
const ReviewSubmissionBase = {
  repo: requiredString('Missing repo selector'),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedHead: ReviewSubmissionHead,
  summary: z
    .string()
    .trim()
    .max(8 * 1024),
  comments: z.array(ReviewSubmissionComment).max(32)
} as const
const HostedReviewSubmit = z
  .discriminatedUnion('provider', [
    z
      .object({
        ...ReviewSubmissionBase,
        provider: z.literal('github'),
        action: z.enum(['comment', 'approve', 'request-changes']),
        repository: z
          .object({
            owner: z.string().min(1).max(256),
            repo: z.string().min(1).max(256),
            host: z.string().min(1).max(256).optional()
          })
          .strict()
      })
      .strict(),
    z
      .object({
        ...ReviewSubmissionBase,
        provider: z.literal('gitlab'),
        action: z.literal('comment'),
        projectRef: z
          .object({
            host: z.string().min(1).max(256),
            path: z.string().min(1).max(1024)
          })
          .strict(),
        baseSha: ReviewSubmissionHead,
        startSha: ReviewSubmissionHead
      })
      .strict()
  ])
  .superRefine((submission, context) => {
    const retainedCharacters =
      submission.summary.length +
      submission.comments.reduce((total, comment) => total + comment.body.length, 0)
    if (retainedCharacters > 64 * 1024) {
      context.addIssue({ code: 'custom', message: 'Review submission is too large' })
    }
  })

export const HOSTED_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'hostedReview.forBranch',
    params: HostedReviewForBranch,
    handler: async (params, { runtime }) => {
      const fallbackGitHubPR =
        params.linkedGitHubPR == null ? (params.fallbackGitHubPR ?? null) : null
      return runtime.getHostedReviewForBranch({
        repoSelector: params.repo,
        branch: params.branch,
        ...(params.admissionTier ? { admissionTier: params.admissionTier } : {}),
        currentHeadOid: params.currentHeadOid ?? null,
        ...(params.active === true ? { active: true } : {}),
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.getCreationEligibility',
    params: HostedReviewCreationEligibility,
    handler: async (params, { runtime }) => {
      const fallbackGitHubPR =
        params.linkedGitHubPR == null ? (params.fallbackGitHubPR ?? null) : null
      return runtime.getHostedReviewCreationEligibility({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        branch: params.branch,
        base: params.base ?? null,
        hasUncommittedChanges: params.hasUncommittedChanges,
        hasUpstream: params.hasUpstream,
        ahead: params.ahead,
        behind: params.behind,
        linkedGitHubPR: params.linkedGitHubPR ?? null,
        ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
        linkedGitLabMR: params.linkedGitLabMR ?? null,
        linkedBitbucketPR: params.linkedBitbucketPR ?? null,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR ?? null,
        linkedGiteaPR: params.linkedGiteaPR ?? null
      })
    }
  }),
  defineMethod({
    name: 'hostedReview.create',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) =>
      runtime.createHostedReview({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        provider: params.provider,
        base: params.base,
        head: params.head,
        title: params.title,
        body: params.body,
        draft: params.draft,
        useTemplate: params.useTemplate
      })
  }),
  defineMethod({
    name: 'hostedReview.submit',
    params: HostedReviewSubmit,
    handler: async (params, { runtime }) => {
      const { repo, ...input } = params
      return runtime.submitHostedReview({ repoSelector: repo, ...input })
    }
  }),
  defineMethod({
    name: 'hostedReview.createStacked',
    params: HostedReviewCreate,
    handler: async (params, { runtime }) =>
      runtime.createStackedHostedReview({
        repoSelector: params.repo,
        worktreeSelector: params.worktree,
        provider: params.provider,
        base: params.base,
        head: params.head,
        title: params.title,
        body: params.body,
        draft: params.draft,
        useTemplate: params.useTemplate
      })
  })
]

function isSafeRelativePath(value: string): boolean {
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false
  }
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}
