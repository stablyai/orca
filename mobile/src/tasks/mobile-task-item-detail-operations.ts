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

// Both consumers distinguish refused reads from accepted null, which means issue not found.
export const linearIssueRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.issue-detail',
    method: 'linear.getIssue',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-issue', linearIssueSchema)
  })
)

// Comment reads are advisory; their refusal must not fail the readable issue in the same request group.
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

// Workflow-state picker reads are advisory; refusal empties only the picker.
export const linearTeamStateListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.team-states-or-skip',
    method: 'linear.teamStates',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-team-states', linearTeamStatesSchema)
  })
)

// Composer team reads may skip refusal; hydration requires the same data and must fail explicitly.
export const linearComposerTeamListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.composer-team-list-or-skip',
    method: 'linear.listTeams',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-teams', linearTeamsSchema)
  })
)
