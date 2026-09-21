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

// What the Tasks list reads to fill itself for a provider, plus the one write that connects a
// Linear account. The per-repo item searches themselves are the Smart picker's operations in
// mobile-task-source-search-operations.ts: the list asks the same methods with the same
// acceptance, so it sends the same operations rather than a second copy.

/**
 * Linear account status for provider hydration, the second of two policies on this method. The
 * Tasks screen cannot list Linear issues without knowing the workspace and surfaces the host's
 * message; the runtime hydration hook's probe in mobile-task-runtime-operations.ts treats an
 * unanswered probe as "not connected" and degrades. One reader serves both.
 */
export const linearAccountStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.account-status',
    method: 'linear.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-account-status', linearAccountStatusSchema)
  })
)

/**
 * The team list for a hydrated Linear workspace, the second of two policies on this method.
 * Hydration cannot reconcile the saved team selection without it and surfaces the host's message;
 * the composer's picker in mobile-task-item-detail-operations.ts empties instead. One reader.
 */
export const linearWorkspaceTeamListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.workspace-team-list',
    method: 'linear.listTeams',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-teams', linearTeamsSchema)
  })
)

/** The GitHub total for the current filter, asked per repo and summed. */
export const githubWorkItemCountRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'github.work-item-count',
    method: 'github.countWorkItems',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('github-work-item-count', githubWorkItemCountSchema)
  })
)

/** The GitLab to-do inbox, which is its own list view rather than a work-item query. */
export const gitlabTodoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'gitlab.todo-list',
    method: 'gitlab.todos',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('gitlab-todos', gitlabTodoListSchema)
  })
)

/**
 * Connecting a Linear account with a pasted API key. A refusal is shown in the connect sheet, and
 * an accepted reply can still carry a soft `{ ok: false, error }` the sheet raises itself.
 */
export const linearAccountConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.connect-account',
    method: 'linear.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-account-connected', linearAccountConnectedSchema)
  })
)

/**
 * A repository's issue-source preference. The screen re-reads the repo list afterwards rather than
 * patching its cached copy, so the reply body is not read — only its refusal is.
 */
export const taskRepoPreferenceWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.update-issue-source',
    method: 'repo.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-updated', taskRepoPreferenceWrittenSchema)
  })
)
