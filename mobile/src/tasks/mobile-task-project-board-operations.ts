import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { githubPrRepoSlugSchema } from '../session/github-pr-read-reply-schema'
import {
  taskProjectAccessibleListSchema,
  taskProjectAssignableUserListSchema,
  taskProjectCommentMutationSchema,
  taskProjectCommentWriteSchema,
  taskProjectIssueTypeListSchema,
  taskProjectLabelListSchema,
  taskProjectMutationStatusSchema,
  taskProjectRefSchema,
  taskProjectRowDetailSchema,
  taskProjectViewListSchema,
  taskProjectViewTableSchema
} from './task-project-board-reply-schema'

// The GitHub Projects board. Every `github.project.*` reply is an accepted result carrying its own
// `{ ok, error }` envelope, which the board reads itself and whose message it prefers over its own
// copy; the acceptance policy only decides whether there is an envelope to read. The board also
// sends the plain `github.*` pull-request operations in mobile-task-item-state-operations.ts,
// with a `prRepo` the item screen does not send — same method, same acceptance, one operation.
//
// Every reader here is checked against task-project-board-reply-schema.ts, which records the
// consumer line behind each requirement. No acceptance changes: `require-result-or-throw-message`
// still carries a refusal to the site's own catch, and it is that policy — not the reader, which
// only ever answers `compatible: false` — that turns an unreadable envelope into the thrown
// RpcIncompatibleReplyError the site reports.

export const githubProjectListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.accessible-list',
    method: 'github.project.listAccessible',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-list', taskProjectAccessibleListSchema)
  })
)

export const githubProjectViewListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.view-list',
    method: 'github.project.listViews',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-views', taskProjectViewListSchema)
  })
)

export const githubProjectViewTableRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.view-table',
    method: 'github.project.viewTable',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-table', taskProjectViewTableSchema)
  })
)

/** A pasted project URL or owner/number. A soft `{ ok: false }` lands in the paste field, not
 *  the board's error line, so the two are distinguished at the site rather than by the policy. */
export const githubProjectRefResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.resolve-ref',
    method: 'github.project.resolveRef',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-ref', taskProjectRefSchema)
  })
)

export const githubProjectRowDetailRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.row-details',
    method: 'github.project.workItemDetailsBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-row-details', taskProjectRowDetailSchema)
  })
)

export const githubProjectLabelListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.repo-labels',
    method: 'github.project.listLabelsBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-labels', taskProjectLabelListSchema)
  })
)

export const githubProjectAssignableUserListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.assignable-users',
    method: 'github.project.listAssignableUsersBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-assignable-users', taskProjectAssignableUserListSchema)
  })
)

export const githubProjectIssueTypeListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.issue-types',
    method: 'github.project.listIssueTypesBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-issue-types', taskProjectIssueTypeListSchema)
  })
)

/**
 * A board row's issue edits. Two call sites send it — the metadata sheet's labels and assignees,
 * and the row editor's title, body and state — and both read `result.ok` off the payload.
 *
 * #20563 left a null reply reaching that read as a property-read TypeError, which the
 * `project.update-metadata` b2 seed records. The checked reader names it instead: a payload that is
 * not an envelope at all is an incompatible `github.project.updateIssueBySlug` reply, and the two
 * sites still differ only in the copy their own catch shows.
 */
export const githubProjectIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue',
    method: 'github.project.updateIssueBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-updated-issue', taskProjectMutationStatusSchema)
  })
)

export const githubProjectPullRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-pull-request',
    method: 'github.project.updatePullRequestBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-updated-pull-request', taskProjectMutationStatusSchema)
  })
)

export const githubProjectIssueTypeUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue-type',
    method: 'github.project.updateIssueTypeBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-updated-issue-type', taskProjectMutationStatusSchema)
  })
)

export const githubProjectFieldUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-item-field',
    method: 'github.project.updateItemField',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-updated-field', taskProjectMutationStatusSchema)
  })
)

export const githubProjectFieldClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.clear-item-field',
    method: 'github.project.clearItemField',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-cleared-field', taskProjectMutationStatusSchema)
  })
)

export const githubProjectCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.add-issue-comment',
    method: 'github.project.addIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-issue-comment', taskProjectCommentWriteSchema)
  })
)

export const githubProjectCommentUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue-comment',
    method: 'github.project.updateIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-updated-comment', taskProjectCommentMutationSchema)
  })
)

export const githubProjectCommentDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.delete-issue-comment',
    method: 'github.project.deleteIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-project-deleted-comment', taskProjectCommentMutationSchema)
  })
)

/**
 * A repo's owner/repo slug, the second of two policies on this method. The board matches its rows
 * against Orca repos and must distinguish "this repo has no slug" from "the ask failed", so it
 * throws and caches the failure for retry; the Smart picker's paste lookup in
 * mobile-task-source-search-operations.ts caches a refusal as "no slug" and carries on, so there
 * a refusal is a skip. One reader serves both — literally: both operations read through
 * `githubPrRepoSlugSchema`, the schema the session domain already wrote for this same reply, since
 * `github.repoSlug` has one shape and three consumers that all answer null without a slug.
 */
export const githubProjectRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project-repo-slug',
    method: 'github.repoSlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-slug', githubPrRepoSlugSchema)
  })
)
