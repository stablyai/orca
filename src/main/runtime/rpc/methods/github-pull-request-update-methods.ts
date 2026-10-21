import { defineMethod } from '../core'
import {
  MarkPrReadyForReview,
  MergePr,
  PRReviewComment,
  PRReviewCommentReply,
  RemovePrReviewers,
  RequestPrReviewers,
  SetPrAutoMerge,
  UpdatePr,
  UpdatePrState,
  UpdatePrTitle
} from '../../../../shared/rpc-contract/github-pull-request-update-params'

export const GITHUB_PULL_REQUEST_UPDATE_METHODS = [
  defineMethod({
    name: 'github.updatePRTitle',
    permission: 'workspace',
    params: UpdatePrTitle,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRTitle(params.repo, params.prNumber, params.title, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.updatePR',
    permission: 'workspace',
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
    permission: 'workspace',
    params: MergePr,
    handler: async (params, { runtime }) =>
      runtime.mergeRepoPR(params.repo, params.prNumber, params.method, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.setPRAutoMerge',
    permission: 'workspace',
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
    permission: 'workspace',
    params: UpdatePrState,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRState(params.repo, params.prNumber, params.updates, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.markPRReadyForReview',
    permission: 'workspace',
    params: MarkPrReadyForReview,
    handler: async (params, { runtime }) =>
      runtime.markRepoPRReadyForReview(params.repo, params.prNumber, params.prRepo ?? null)
  }),
  defineMethod({
    name: 'github.requestPRReviewers',
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
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
