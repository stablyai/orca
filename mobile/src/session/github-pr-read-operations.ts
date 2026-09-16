import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { githubPrCheckDetailsSchema } from './github-pr-check-reply-schema'
import {
  githubPrAssignableUsersSchema,
  githubPrChecksSchema,
  githubPrForBranchSchema,
  githubPrRepoSlugSchema,
  githubWorkItemDetailsSchema,
  hostedReviewForBranchSchema
} from './github-pr-read-reply-schema'

// The PR sidebar's reads. Every one of these replies was re-typed and hand-parsed at the wrapper;
// the schemas in github-pr-read-reply-schema.ts are now the only place that says what each payload
// is. They keep every identity requirement the parsers had, so a payload that used to degrade to
// null still degrades to null — what changes is a payload that is not the declared container at
// all, which is an incompatible reply rather than a silent "nothing found".
//
// All seven share one acceptance: a refused read is an error the sidebar shows, never a skip. The
// wrapper turns the throw back into its `{ ok: false, error }` outcome, which is the contract the
// sidebar's loaders route on.

/** Whether the worktree's repo has a GitHub remote, which gates the dedicated PR-view icon. */
export const githubPrRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-repo-slug',
    method: 'github.repoSlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-repo-slug', githubPrRepoSlugSchema)
  })
)

export const hostedReviewBranchLookupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.for-branch',
    method: 'hostedReview.forBranch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('hosted-review-for-branch', hostedReviewForBranchSchema)
  })
)

/**
 * The one read whose value is an outcome rather than an entity: a host that could not reach GitHub
 * answers in-band with `kind: 'upstream-error'` and its own message, which the sidebar has always
 * surfaced. The reader decodes that arm instead of throwing it, so the message survives a decode
 * that cannot carry one; `resolveGithubPrForBranchOutcome` at the call site is what turns it into
 * the error.
 */
export const githubPrForBranchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-for-branch',
    method: 'github.prForBranch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-for-branch', githubPrForBranchSchema)
  })
)

export const githubPrWorkItemDetailsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-work-item-details',
    method: 'github.workItemDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-work-item-details', githubWorkItemDetailsSchema)
  })
)

export const githubPrChecksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-checks',
    method: 'github.prChecks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-checks', githubPrChecksSchema)
  })
)

export const githubPrCheckDetailsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-check-details',
    method: 'github.prCheckDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-check-run-details', githubPrCheckDetailsSchema)
  })
)

export const githubPrAssignableUsersRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.pr-assignable-users',
    method: 'github.listAssignableUsers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-assignable-users', githubPrAssignableUsersSchema)
  })
)
