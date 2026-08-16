import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { RepoSelector, SlugRepo } from './github-repo-target-schemas'

const UpdatePrTitle = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  title: requiredString('Missing title'),
  prRepo: SlugRepo.nullable().optional()
})

const UpdatePr = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  updates: z.object({
    title: OptionalString,
    body: z.string().optional()
  }),
  prRepo: SlugRepo.nullable().optional()
})

const MergePr = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  prRepo: SlugRepo.nullable().optional()
})

const SetPrAutoMerge = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  enabled: z.boolean(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  prRepo: SlugRepo.nullable().optional()
})

const UpdatePrState = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  updates: z.object({
    state: z.enum(['open', 'closed'])
  })
})

const RequestPrReviewers = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  reviewers: z.array(z.string()).min(1)
})

const RemovePrReviewers = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  reviewers: z.array(z.string()).min(1)
})

const PRReviewComment = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  commitId: requiredString('Missing PR head SHA'),
  path: requiredString('File path required'),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  body: requiredString('Comment body required')
})

const PRReviewCommentReply = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  commentId: z.number().int().positive(),
  body: requiredString('Comment body required'),
  threadId: OptionalString,
  path: OptionalString,
  line: z.number().int().positive().optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const GITHUB_PULL_REQUEST_UPDATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.updatePRTitle',
    params: UpdatePrTitle,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRTitle(params.repo, params.prNumber, params.title, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.updatePR',
    params: UpdatePr,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRDetails(
        params.repo,
        params.prNumber,
        params.updates,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.mergePR',
    params: MergePr,
    handler: async (params, { runtime }) =>
      runtime.mergeRepoPR(params.repo, params.prNumber, params.method, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.setPRAutoMerge',
    params: SetPrAutoMerge,
    handler: async (params, { runtime }) =>
      runtime.setRepoPRAutoMerge(
        params.repo,
        params.prNumber,
        params.enabled,
        params.method,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.updatePRState',
    params: UpdatePrState,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRState(params.repo, params.prNumber, params.updates, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.requestPRReviewers',
    params: RequestPrReviewers,
    handler: async (params, { runtime }) =>
      runtime.requestRepoPRReviewers(
        params.repo,
        params.prNumber,
        params.reviewers,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.removePRReviewers',
    params: RemovePrReviewers,
    handler: async (params, { runtime }) =>
      runtime.removeRepoPRReviewers(
        params.repo,
        params.prNumber,
        params.reviewers,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.addPRReviewComment',
    params: PRReviewComment,
    handler: async (params, { runtime }) =>
      runtime.addRepoPRReviewComment(params.repo, {
        prNumber: params.prNumber,
        prRepo: params.prRepo ?? null,
        commitId: params.commitId,
        path: params.path,
        line: params.line,
        startLine: params.startLine,
        body: params.body
      })
  }),
  defineMethod({
    name: 'github.addPRReviewCommentReply',
    params: PRReviewCommentReply,
    handler: async (params, { runtime }) =>
      runtime.addRepoPRReviewCommentReply(params.repo, {
        prNumber: params.prNumber,
        commentId: params.commentId,
        body: params.body,
        threadId: params.threadId,
        path: params.path,
        line: params.line,
        prRepo: params.prRepo ?? null
      })
  })
]
