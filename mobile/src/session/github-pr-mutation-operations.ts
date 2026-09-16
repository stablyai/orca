import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcMethodName } from '../transport/rpc-params-contract'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import {
  rpcPayloadMember,
  rpcReadUnchecked,
  rpcUncheckedPayloadReader
} from '../transport/rpc-reader-payload'

// Host-state changes on the `github.*` PR surface. A lost reply here is *unknown*, never failed:
// none of these operations interprets a transport rejection, so the rejection object — and the
// delivery-unknown mark the WeakSet holds on it — reaches the wrapper's own catch intact. The
// wrappers still collapse it into their `{ ok: false }` outcome, exactly as main did; nothing here
// retries, and no operation below treats a dropped reply as evidence the mutation did not happen.

/**
 * What a PR mutation reported in-band. `structured: false` is the host returning void or a bare
 * value with no `ok` member, which every caller has always read as success.
 */
export type GitHubPrMutationStatus =
  | { readonly structured: false }
  | { readonly structured: true; readonly ok: unknown; readonly error: unknown }

/**
 * One reader for ten methods, not ten readers.
 *
 * The `ok in result` test and the `error` read are a single host convention — GitHubProjectMutation
 * -Result and GitHubCommentResult share it — so there is no input on which two of these methods
 * would want different answers. Which failure text a caller shows is the caller's, not the
 * reader's: `extractMutationError` still names the method in its fallback.
 */
const mutationStatusReader: RpcCompatibleReader<
  unknown,
  'pr-mutation-status',
  GitHubPrMutationStatus
> = (raw) =>
  raw && typeof raw === 'object' && 'ok' in raw
    ? rpcReadUnchecked('pr-mutation-status', {
        structured: true,
        ok: raw.ok,
        error: rpcPayloadMember(raw, 'error')
      })
    : rpcReadUnchecked('pr-mutation-status', { structured: false })

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

// The two mutations whose host result is a bare boolean rather than a status envelope. Their
// payload is unread here on purpose: `=== true` is the caller's confirmation rule, and reading it
// as a status would turn a `false` into the "no structured status" success the envelope methods get.
export const githubPrTitleSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.update-pr-title',
    method: 'github.updatePRTitle',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('pr-mutation-confirmation')
  })
)

export const githubPrReviewThreadResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.resolve-review-thread',
    method: 'github.resolveReviewThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('pr-mutation-confirmation')
  })
)
