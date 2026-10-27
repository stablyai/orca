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

// Project callers interpret accepted ok/error envelopes; policy handles refusal and malformed-envelope errors.
// Reuse plain PR operations where method and acceptance match, regardless of extra prRepo parameters.

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

// Both editors read ok unguarded; reject null envelopes as incompatible replies before either property access.
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

// Board slug reads must distinguish no slug from failure for retry; Smart paste can skip refusal. Both share the session schema.
export const githubProjectRepoSlugRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.project-repo-slug',
    method: 'github.repoSlug',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-slug', githubPrRepoSlugSchema)
  })
)
