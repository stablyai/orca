import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  linearCommentWrittenSchema,
  reviewThreadResolvedSchema,
  taskCommentWrittenSchema
} from './task-item-comment-reply-schema'

// Writing comments and replies on a task item, over all three providers. Every one of these
// answers with an accepted `{ ok, error, comment }` envelope the call site reads itself, and every
// one keeps its own fallback copy for an envelope that carries no error text — so the acceptance
// policy here only decides whether there is an envelope to read at all.
//
// The five that answer with a comment share one reader, because they share one reply convention;
// each schema lives in task-item-comment-reply-schema.ts with the consumer line behind it.

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

/** Linear answers with an id rather than a comment, which the sheet turns into a local row. */
export const linearIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.add-issue-comment',
    method: 'linear.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-comment-written', linearCommentWrittenSchema)
  })
)

/** Resolving or reopening a review thread. The reply is `true` or the write did not happen. */
export const githubReviewThreadResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.resolve-review-thread',
    method: 'github.resolveReviewThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-review-thread-resolved', reviewThreadResolvedSchema)
  })
)
