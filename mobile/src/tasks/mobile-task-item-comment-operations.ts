import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// Writing comments and replies on a task item, over all three providers. Every one of these
// answers with an accepted `{ ok, error, comment }` envelope the call site reads itself, and every
// one keeps its own fallback copy for an envelope that carries no error text — so the acceptance
// policy here only decides whether there is an envelope to read at all.

export const githubIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-issue-comment',
    method: 'github.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-issue-comment')
  })
)

export const githubReviewCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-pr-review-comment',
    method: 'github.addPRReviewComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-review-comment')
  })
)

export const githubReviewCommentReplyWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.add-pr-review-comment-reply',
    method: 'github.addPRReviewCommentReply',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-review-comment-reply')
  })
)

export const gitlabIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.add-issue-comment',
    method: 'gitlab.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-issue-comment')
  })
)

export const gitlabMergeRequestCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.add-mr-comment',
    method: 'gitlab.addMRComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('gitlab-mr-comment')
  })
)

/** Linear answers with an id rather than a comment, which the sheet turns into a local row. */
export const linearIssueCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.add-issue-comment',
    method: 'linear.addIssueComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('linear-issue-comment')
  })
)

/** Resolving or reopening a review thread. The reply is `true` or the write did not happen. */
export const githubReviewThreadResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.resolve-review-thread',
    method: 'github.resolveReviewThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-review-thread-resolved')
  })
)
