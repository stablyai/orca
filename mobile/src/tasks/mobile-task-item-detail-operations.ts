import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  githubAssignableUsersSchema,
  githubRepoLabelsSchema,
  githubWorkItemDetailSchema,
  gitlabWorkItemDetailSchema,
  linearIssueCommentsSchema,
  linearIssueSchema,
  linearTeamStatesSchema,
  linearTeamsSchema
} from './task-item-detail-reply-schema'

// What one task item's detail sheet reads: the provider's own detail payload, the Linear comment
// list beside it, and the label, assignee and workflow-state pickers the sheet opens. Each schema
// lives in task-item-detail-reply-schema.ts with the consumer line behind every requirement.

export const githubItemDetailRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-details',
    method: 'github.workItemDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-item-details', githubWorkItemDetailSchema)
  })
)

export const gitlabItemDetailRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.work-item-details',
    method: 'gitlab.workItemDetails',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-work-item-details', gitlabWorkItemDetailSchema)
  })
)

/**
 * One Linear issue. The detail sheet and the sub-issue opener share it: both throw the host's
 * message on refusal and both treat an accepted `null` as "not found" with their own copy, which
 * is the fallback each keeps at its own site.
 */
export const linearIssueRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.issue-detail',
    method: 'linear.getIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-issue', linearIssueSchema)
  })
)

/**
 * The comment list beside a Linear issue, asked in the same group as the issue itself. A refused
 * comment read leaves the sheet with no comments rather than failing it, so refusal is a skip —
 * which is exactly why the two legs of that group cannot share one policy.
 */
export const linearIssueCommentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.issue-comments-or-skip',
    method: 'linear.issueComments',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-issue-comments', linearIssueCommentsSchema)
  })
)

export const githubRepoLabelListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.repo-labels',
    method: 'github.listLabels',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-labels', githubRepoLabelsSchema)
  })
)

export const githubAssignableUserListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.assignable-users',
    method: 'github.listAssignableUsers',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-assignable-users', githubAssignableUsersSchema)
  })
)

/**
 * A Linear team's workflow states, for the status picker. Advisory: a refusal empties the picker
 * rather than failing the sheet, so it is a skip.
 */
export const linearTeamStateListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.team-states-or-skip',
    method: 'linear.teamStates',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-team-states', linearTeamStatesSchema)
  })
)

/**
 * The composer's Linear team list, the first of two policies on this method. The composer empties
 * its picker on a refusal and stays open; hydration in mobile-task-list-operations.ts cannot
 * proceed without the list and surfaces the host's message. One reader serves both.
 */
/** Shared with hydration's leg in the list module: one team list, so the composer's picker and
 *  the saved-selection reconciler can never disagree about what a team row is. */
export const linearTeamListReader = rpcResultVariant('linear-teams', linearTeamsSchema)

export const linearComposerTeamListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.composer-team-list-or-skip',
    method: 'linear.listTeams',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: linearTeamListReader
  })
)
