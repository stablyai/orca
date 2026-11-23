import { normalizeClickUpTaskListFilter } from '../../../../../../shared/clickup/clickup-task-filter'
import { defineMethod } from '../../../core'
import {
  ClickUpAddTaskCommentParams,
  ClickUpConnectParams,
  ClickUpListStatusesParams,
  ClickUpListTasksParams,
  ClickUpSearchTasksParams,
  ClickUpSelectWorkspaceParams,
  ClickUpTaskIdParams,
  ClickUpUpdateTaskParams
} from '../../../../../../shared/rpc-contract/clickup/clickup-params'

export const CLICKUP_METHODS = [
  defineMethod({
    name: 'clickup.connect',
    permission: 'accounts-admin',
    params: ClickUpConnectParams,
    handler: async (params, { runtime }) => runtime.clickupConnect(params.token.trim())
  }),
  defineMethod({
    name: 'clickup.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickupDisconnect()
  }),
  defineMethod({
    name: 'clickup.selectWorkspace',
    permission: 'accounts-admin',
    params: ClickUpSelectWorkspaceParams,
    handler: async (params, { runtime }) =>
      runtime.clickupSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'clickup.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickupStatus()
  }),
  defineMethod({
    name: 'clickup.testConnection',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickupTestConnection()
  }),
  defineMethod({
    name: 'clickup.listTasks',
    permission: 'workspace',
    params: ClickUpListTasksParams,
    handler: async (params, { runtime }) =>
      runtime.clickupListTasks(
        params?.filter ?? normalizeClickUpTaskListFilter(undefined),
        params?.page ?? 0
      )
  }),
  defineMethod({
    name: 'clickup.searchTasks',
    permission: 'workspace',
    params: ClickUpSearchTasksParams,
    handler: async (params, { runtime }) =>
      runtime.clickupSearchTasks(
        params.query.trim(),
        params.filter ?? normalizeClickUpTaskListFilter(undefined),
        params.fresh === true
      )
  }),
  defineMethod({
    name: 'clickup.getTask',
    permission: 'workspace',
    params: ClickUpTaskIdParams,
    handler: async (params, { runtime }) => runtime.clickupGetTask(params.id.trim())
  }),
  defineMethod({
    name: 'clickup.taskComments',
    permission: 'workspace',
    params: ClickUpTaskIdParams,
    handler: async (params, { runtime }) => runtime.clickupTaskComments(params.id.trim())
  }),
  defineMethod({
    name: 'clickup.addTaskComment',
    permission: 'workspace',
    params: ClickUpAddTaskCommentParams,
    handler: async (params, { runtime }) =>
      runtime.clickupAddTaskComment(params.id.trim(), params.body)
  }),
  defineMethod({
    name: 'clickup.listStatuses',
    permission: 'workspace',
    params: ClickUpListStatusesParams,
    handler: async (params, { runtime }) => runtime.clickupListStatuses(params.listId.trim())
  }),
  defineMethod({
    name: 'clickup.updateTask',
    permission: 'workspace',
    params: ClickUpUpdateTaskParams,
    handler: async (params, { runtime }) =>
      runtime.clickupUpdateTask(params.id.trim(), params.updates)
  })
]
