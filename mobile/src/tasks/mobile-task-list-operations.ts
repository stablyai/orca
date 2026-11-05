import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { linearTeamsSchema } from './task-item-detail-reply-schema'
import {
  githubWorkItemCountSchema,
  gitlabTodoListSchema,
  linearAccountConnectedSchema,
  linearAccountStatusSchema,
  taskRepoPreferenceWrittenSchema
} from './task-list-reply-schema'

// Reuse Smart-picker search operations; list reads need the same methods and acceptance policy.

// Hydration requires Linear workspace identity; the runtime’s advisory probe may instead skip refusal.
export const linearAccountStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.account-status',
    method: 'linear.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-account-status', linearAccountStatusSchema)
  })
)

// Hydration requires team selection data; the composer’s same-method picker may degrade to empty.
export const linearWorkspaceTeamListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.workspace-team-list',
    method: 'linear.listTeams',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-teams', linearTeamsSchema)
  })
)

export const githubWorkItemCountRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-count',
    method: 'github.countWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-item-count', githubWorkItemCountSchema)
  })
)

export const gitlabTodoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.todo-list',
    method: 'gitlab.todos',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-todos', gitlabTodoListSchema)
  })
)

// Accepted Linear connection replies may still fail in-band.
export const linearAccountConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.connect-account',
    method: 'linear.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-account-connected', linearAccountConnectedSchema)
  })
)

// Reload the repo list after preference writes; only acceptance is consumed, not the payload.
export const taskRepoPreferenceWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.update-issue-source',
    method: 'repo.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-updated', taskRepoPreferenceWrittenSchema)
  })
)
