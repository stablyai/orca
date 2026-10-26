import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  linearCommentWrittenSchema,
  reviewThreadResolvedSchema,
  taskCommentWrittenSchema
} from './task-item-comment-reply-schema'

// Accepted comment envelopes may fail in-band; callers keep provider-specific fallback copy.

const taskCommentWrittenReader = rpcResultVariant('task-comment-written', taskCommentWrittenSchema)

export const githubIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-issue-comment',
    method: 'github.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskCommentWrittenReader
  })
)

export const githubReviewCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-pr-review-comment',
    method: 'github.addPRReviewComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskCommentWrittenReader
  })
)

export const githubReviewCommentReplyWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-pr-review-comment-reply',
    method: 'github.addPRReviewCommentReply',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskCommentWrittenReader
  })
)

export const gitlabIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.add-issue-comment',
    method: 'gitlab.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskCommentWrittenReader
  })
)

export const gitlabMergeRequestCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.add-mr-comment',
    method: 'gitlab.addMRComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: taskCommentWrittenReader
  })
)

export const linearIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.add-issue-comment',
    method: 'linear.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-comment-written', linearCommentWrittenSchema)
  })
)

// Thread toggles acknowledge with true; any other reply means the write did not happen.
export const githubReviewThreadResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.resolve-review-thread',
    method: 'github.resolveReviewThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-review-thread-resolved', reviewThreadResolvedSchema)
  })
)
