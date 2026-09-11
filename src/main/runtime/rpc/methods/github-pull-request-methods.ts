import { defineMethod, type RpcMethod } from '../core'
import {
  PRCommentReaction,
  PrForBranch,
  PullRequest,
  PullRequestCheckDetails,
  PullRequestChecks,
  PullRequestFileContents,
  PullRequestFileViewed,
  RerunPullRequestChecks,
  ReviewThread
} from '../../../../shared/rpc-contract/github-pull-request-params'

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
        params.currentHeadOid,
        params.reason
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
