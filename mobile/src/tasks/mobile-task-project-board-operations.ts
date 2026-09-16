import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// The GitHub Projects board. Every `github.project.*` reply is an accepted result carrying its own
// `{ ok, error }` envelope, which the board reads itself and whose message it prefers over its own
// copy; the acceptance policy only decides whether there is an envelope to read. The board also
// sends the plain `github.*` pull-request operations in mobile-task-item-state-operations.ts,
// with a `prRepo` the item screen does not send — same method, same acceptance, one operation.

export const githubProjectListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.accessible-list',
    method: 'github.project.listAccessible',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-list')
  })
)

export const githubProjectViewListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.view-list',
    method: 'github.project.listViews',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-views')
  })
)

export const githubProjectViewTableRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.view-table',
    method: 'github.project.viewTable',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-table')
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
    read: rpcUncheckedPayloadReader('github-project-ref')
  })
)

export const githubProjectRowDetailRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.row-details',
    method: 'github.project.workItemDetailsBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-row-details')
  })
)

export const githubProjectLabelListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.repo-labels',
    method: 'github.project.listLabelsBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-labels')
  })
)

export const githubProjectAssignableUserListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.assignable-users',
    method: 'github.project.listAssignableUsersBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-assignable-users')
  })
)

export const githubProjectIssueTypeListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.issue-types',
    method: 'github.project.listIssueTypesBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-issue-types')
  })
)

/**
 * A board row's issue edits. Two call sites send it — the metadata sheet's labels and assignees,
 * and the row editor's title, body and state — and they disagree about a null reply: the metadata
 * sheet reads `result.ok` off it and throws a property-read TypeError, which #20563 left in place
 * as recorded behaviour. That difference is in the call sites, not in the acceptance.
 */
export const githubProjectIssueUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue',
    method: 'github.project.updateIssueBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-updated-issue')
  })
)

export const githubProjectPullRequestUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-pull-request',
    method: 'github.project.updatePullRequestBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-updated-pull-request')
  })
)

export const githubProjectIssueTypeUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue-type',
    method: 'github.project.updateIssueTypeBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-updated-issue-type')
  })
)

export const githubProjectFieldUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-item-field',
    method: 'github.project.updateItemField',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-updated-field')
  })
)

export const githubProjectFieldClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.clear-item-field',
    method: 'github.project.clearItemField',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-cleared-field')
  })
)

export const githubProjectCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.add-issue-comment',
    method: 'github.project.addIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-issue-comment')
  })
)

export const githubProjectCommentUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.update-issue-comment',
    method: 'github.project.updateIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-updated-comment')
  })
)

export const githubProjectCommentDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project.delete-issue-comment',
    method: 'github.project.deleteIssueCommentBySlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('github-project-deleted-comment')
  })
)

/**
 * A repo's owner/repo slug, the second of two policies on this method. The board matches its rows
 * against Orca repos and must distinguish "this repo has no slug" from "the ask failed", so it
 * throws and caches the failure for retry; the Smart picker's paste lookup in
 * mobile-task-source-search-operations.ts caches a refusal as "no slug" and carries on, so there
 * a refusal is a skip. One reader serves both.
 */
export const githubProjectRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project-repo-slug',
    method: 'github.repoSlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('repo-slug')
  })
)
