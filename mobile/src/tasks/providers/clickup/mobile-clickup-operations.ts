import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import {
  clickUpCommentListSchema,
  clickUpConnectionStatusSchema,
  clickUpStatusListSchema,
  clickUpTaskListSchema,
  clickUpTaskOrNullSchema,
  clickUpTaskPageSchema,
  clickUpWriteResultSchema
} from './clickup-reply-schema'

// The ClickUp token is stored on the paired desktop; the phone reads and writes tasks through it.

const clickUpStatusReader = rpcResultVariant('clickup-status', clickUpConnectionStatusSchema)

export const clickUpConnectionStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.connection-status',
    method: 'clickup.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: clickUpStatusReader
  })
)

export const clickUpConnectionStatusProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.connection-status-or-skip',
    method: 'clickup.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: clickUpStatusReader
  })
)

export const clickUpWorkspaceSelect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.select-workspace',
    method: 'clickup.selectWorkspace',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: clickUpStatusReader
  })
)

export const clickUpTaskPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.task-page',
    method: 'clickup.listTasks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-task-page', clickUpTaskPageSchema)
  })
)

export const clickUpTaskSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.task-search',
    method: 'clickup.searchTasks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-task-search', clickUpTaskListSchema)
  })
)

export const clickUpTaskRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.task',
    method: 'clickup.getTask',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-task', clickUpTaskOrNullSchema)
  })
)

export const clickUpTaskCommentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.task-comments-or-skip',
    method: 'clickup.taskComments',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-comments', clickUpCommentListSchema)
  })
)

export const clickUpStatusesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.list-statuses',
    method: 'clickup.listStatuses',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-statuses', clickUpStatusListSchema)
  })
)

export const clickUpCommentWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.add-task-comment',
    method: 'clickup.addTaskComment',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-comment-written', clickUpWriteResultSchema)
  })
)

export const clickUpTaskUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clickup.update-task',
    method: 'clickup.updateTask',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clickup-task-updated', clickUpWriteResultSchema)
  })
)
