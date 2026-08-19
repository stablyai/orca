import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { RepoSelector, SlugRepo } from './github-repo-target-schemas'

const PrForBranch = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  linkedPRNumber: z.number().int().positive().nullable().optional(),
  fallbackPRNumber: z.number().int().positive().nullable().optional(),
  acceptMergedFallbackPR: z.boolean().optional(),
  currentHeadOid: z.string().nullable().optional()
})

const PullRequest = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  noCache: z.boolean().optional(),
  prRepo: SlugRepo.nullable().optional()
})

const PRCommentReaction = RepoSelector.extend({
  reactionSubjectId: requiredString('Missing reaction subject ID'),
  content: z.enum(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
  reacted: z.boolean(),
  prRepo: SlugRepo.nullable().optional()
})

const PullRequestChecks = PullRequest.extend({
  headSha: OptionalString
})

const PullRequestCheckDetails = RepoSelector.extend({
  checkRunId: z.number().int().positive().optional(),
  workflowRunId: z.number().int().positive().optional(),
  checkName: OptionalString,
  url: OptionalString.nullable().optional(),
  prRepo: SlugRepo.nullable().optional()
})

const RerunPullRequestChecks = PullRequest.extend({
  headSha: OptionalString,
  failedOnly: z.boolean().optional()
})

const PullRequestFileContents = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  path: requiredString('Missing file path'),
  oldPath: OptionalString,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  headSha: requiredString('Missing head SHA'),
  baseSha: requiredString('Missing base SHA')
})

const PullRequestFileViewed = RepoSelector.extend({
  prRepo: SlugRepo.nullable().optional(),
  pullRequestId: requiredString('Missing pull request ID'),
  path: requiredString('Missing file path'),
  viewed: z.boolean()
})

const ReviewThread = RepoSelector.extend({
  prRepo: SlugRepo.nullable().optional(),
  threadId: requiredString('Missing thread ID'),
  resolve: z.boolean()
})

export const GITHUB_PULL_REQUEST_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.prForBranch',
    params: PrForBranch,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRForBranch(
        params.repo,
        params.branch,
        params.linkedPRNumber,
        params.fallbackPRNumber,
        params.acceptMergedFallbackPR,
        params.currentHeadOid
      )
  }),
  defineMethod({
    name: 'github.prChecks',
    params: PullRequestChecks,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRChecks(params.repo, params.prNumber, params.headSha, params.prRepo ?? null, {
        noCache: params.noCache
      })
  }),
  defineMethod({
    name: 'github.prCheckDetails',
    params: PullRequestCheckDetails,
    handler: async (params, { runtime, signal }) =>
      runtime.getRepoPRCheckDetails(
        params.repo,
        {
          checkRunId: params.checkRunId,
          workflowRunId: params.workflowRunId,
          checkName: params.checkName,
          url: params.url,
          prRepo: params.prRepo ?? null
        },
        signal
      )
  }),
  defineMethod({
    name: 'github.rerunPRChecks',
    params: RerunPullRequestChecks,
    handler: async (params, { runtime }) =>
      runtime.rerunRepoPRChecks(params.repo, params.prNumber, {
        headSha: params.headSha,
        failedOnly: params.failedOnly,
        prRepo: params.prRepo ?? null
      })
  }),
  defineMethod({
    name: 'github.prComments',
    params: PullRequest,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRComments(params.repo, params.prNumber, params.prRepo ?? null, {
        noCache: params.noCache
      })
  }),
  defineMethod({
    name: 'github.setPRCommentReaction',
    params: PRCommentReaction,
    handler: async (params, { runtime }) =>
      runtime.setRepoPRCommentReaction(
        params.repo,
        params.reactionSubjectId,
        params.content,
        params.reacted,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.prFileContents',
    params: PullRequestFileContents,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRFileContents(params.repo, {
        prNumber: params.prNumber,
        prRepo: params.prRepo ?? null,
        path: params.path,
        oldPath: params.oldPath,
        status: params.status,
        headSha: params.headSha,
        baseSha: params.baseSha
      })
  }),
  defineMethod({
    name: 'github.resolveReviewThread',
    params: ReviewThread,
    handler: async (params, { runtime }) =>
      runtime.resolveRepoReviewThread(
        params.repo,
        params.threadId,
        params.resolve,
        params.prRepo ?? null
      )
  }),
  defineMethod({
    name: 'github.setPRFileViewed',
    params: PullRequestFileViewed,
    handler: async (params, { runtime }) =>
      runtime.setRepoPRFileViewed(params.repo, {
        prRepo: params.prRepo ?? null,
        pullRequestId: params.pullRequestId,
        path: params.path,
        viewed: params.viewed
      })
  })
]
