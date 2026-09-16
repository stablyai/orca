import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcMethodName } from '../transport/rpc-params-contract'
import { rpcResultVariant, rpcResultVariants } from '../transport/rpc-operation-result-reader'
import {
  githubPrMutationConfirmationSchema,
  githubPrMutationStatusSchemas,
  type GitHubPrMutationStatus
} from './github-pr-mutation-reply-schema'

// Host-state changes on the `github.*` PR surface. A lost reply here is *unknown*, never failed:
// none of these operations interprets a transport rejection, so the rejection object — and the
// delivery-unknown mark the WeakSet holds on it — reaches the wrapper's own catch intact. The
// wrappers still collapse it into their `{ ok: false }` outcome, exactly as main did; nothing here
// retries, and no operation below treats a dropped reply as evidence the mutation did not happen.

export type { GitHubPrMutationStatus } from './github-pr-mutation-reply-schema'

/**
 * One reader for ten methods, not ten readers.
 *
 * The `ok` test and the `error` read are a single host convention — GitHubProjectMutationResult
 * and GitHubCommentResult share it — so there is no input on which two of these methods would want
 * different answers. Which failure text a caller shows is the caller's, not the reader's:
 * `extractMutationError` still names the method in its fallback. Two variants rather than one
 * schema because the host's own result is a union whose arms require different members.
 */
const mutationStatusReader = rpcResultVariants<
  'pr-mutation-status' | 'pr-mutation-void',
  GitHubPrMutationStatus
>([
  rpcResultVariant('pr-mutation-status', githubPrMutationStatusSchemas[0]),
  rpcResultVariant('pr-mutation-void', githubPrMutationStatusSchemas[1])
])

// Ten operations, one definition site: they share a method-independent acceptance, barrier and
// reader, and writing the same five lines ten times would hide that rather than show it. Name and
// method stay per operation, which is what a call site picks.
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

// The two mutations whose host result is a bare boolean rather than a status envelope. `=== true`
// is the caller's confirmation rule, so reading them as a status would turn a `false` into the
// "no structured status" success the envelope methods get.
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
