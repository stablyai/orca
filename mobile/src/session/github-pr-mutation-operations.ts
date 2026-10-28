import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcMethodName } from '../transport/rpc-params-contract'
import { rpcResultVariant, rpcResultVariants } from '../transport/rpc-operation-result-reader'
import {
  githubPrMutationConfirmationSchema,
  githubPrMutationStatusSchemas,
  type GitHubPrMutationStatus
} from './github-pr-mutation-reply-schema'

// Transport rejection preserves its delivery-unknown identity; never retry or infer that a dropped reply means no mutation occurred.

export type { GitHubPrMutationStatus } from './github-pr-mutation-reply-schema'

// Share the host’s status/void convention across methods; callers own fallback failure text.
const mutationStatusReader = rpcResultVariants<
  'pr-mutation-status' | 'pr-mutation-void',
  GitHubPrMutationStatus
>([
  rpcResultVariant('pr-mutation-status', githubPrMutationStatusSchemas[0]),
  rpcResultVariant('pr-mutation-void', githubPrMutationStatusSchemas[1])
])

function mutationStatusOperation<Method extends RpcMethodName>(name: string, method: Method) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: mutationStatusReader
    })
  )
}

export const githubPrMergeRun = mutationStatusOperation('github.merge-pr', 'github.mergePR')

export const githubPrAutoMergeSet = mutationStatusOperation(
  'github.set-pr-auto-merge',
  'github.setPRAutoMerge'
)

export const githubPrStateSet = mutationStatusOperation(
  'github.update-pr-state',
  'github.updatePRState'
)

export const githubPrReadyForReviewMark = mutationStatusOperation(
  'github.mark-pr-ready-for-review',
  'github.markPRReadyForReview'
)

export const githubPrReviewersRequest = mutationStatusOperation(
  'github.request-pr-reviewers',
  'github.requestPRReviewers'
)

export const githubPrReviewersRemove = mutationStatusOperation(
  'github.remove-pr-reviewers',
  'github.removePRReviewers'
)

export const githubPrChecksRerun = mutationStatusOperation(
  'github.rerun-pr-checks',
  'github.rerunPRChecks'
)

export const githubPrReviewCommentReplyAdd = mutationStatusOperation(
  'github.add-pr-review-comment-reply',
  'github.addPRReviewCommentReply'
)

export const githubPrIssueCommentAdd = mutationStatusOperation(
  'github.add-issue-comment',
  'github.addIssueComment'
)

export const githubPrIssueCommentEdit = mutationStatusOperation(
  'github.update-issue-comment-by-slug',
  'github.project.updateIssueCommentBySlug'
)

export const githubPrIssueCommentDelete = mutationStatusOperation(
  'github.delete-issue-comment-by-slug',
  'github.project.deleteIssueCommentBySlug'
)

// These two methods require explicit boolean confirmation; status-envelope void-success semantics would accept false.
export const githubPrTitleSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pr-title',
    method: 'github.updatePRTitle',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-mutation-confirmation', githubPrMutationConfirmationSchema)
  })
)

export const githubPrReviewThreadResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.resolve-review-thread',
    method: 'github.resolveReviewThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-mutation-confirmation', githubPrMutationConfirmationSchema)
  })
)
