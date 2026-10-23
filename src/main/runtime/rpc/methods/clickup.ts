import { defineMethod } from '../core'
import {
  ClickUpConnect,
  ClickUpCreateTask,
  ClickUpListLists,
  ClickUpListTasks,
  ClickUpSearchTasks,
  ClickUpSelectWorkspace,
  ClickUpTaskComment,
  ClickUpTaskId,
  ClickUpTaskUpdate,
  ClickUpWorkspaceSelection
} from '../../../../shared/rpc-contract/clickup-params'

export const CLICKUP_METHODS = [
  defineMethod({
    name: 'clickup.connect',
    permission: 'accounts-admin',
    params: ClickUpConnect,
    handler: async (params, { runtime }) => runtime.clickUpConnect(params.apiToken.trim())
  }),
  defineMethod({
    name: 'clickup.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpDisconnect()
  }),
  defineMethod({
    name: 'clickup.selectWorkspace',
    permission: 'accounts-admin',
    params: ClickUpSelectWorkspace,
    handler: async (params, { runtime }) =>
      runtime.clickUpSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'clickup.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpStatus()
  }),
  defineMethod({
    name: 'clickup.testConnection',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpTestConnection()
  }),
  defineMethod({
    name: 'clickup.searchTasks',
    permission: 'workspace',
    params: ClickUpSearchTasks,
    handler: async (params, { runtime }) =>
      runtime.clickUpSearchTasks(params.query, params.limit, params.workspaceId, params.scope)
  }),
  defineMethod({
    name: 'clickup.listTasks',
    permission: 'workspace',
    params: ClickUpListTasks,
    handler: async (params, { runtime }) =>
      runtime.clickUpListTasks(params?.filter, params?.limit, params?.workspaceId, params?.scope)
  }),
  defineMethod({
    name: 'clickup.getTask',
    permission: 'workspace',
    params: ClickUpTaskId,
    handler: async (params, { runtime }) =>
      runtime.clickUpGetTask(params.taskId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.createTask',
    permission: 'workspace',
    params: ClickUpCreateTask,
    handler: async (params, { runtime }) => runtime.clickUpCreateTask(params)
  }),
  defineMethod({
    name: 'clickup.updateTask',
    permission: 'workspace',
    params: ClickUpTaskUpdate,
    handler: async (params, { runtime }) =>
      runtime.clickUpUpdateTask(params.taskId.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.addTaskComment',
    permission: 'workspace',
    params: ClickUpTaskComment,
    handler: async (params, { runtime }) =>
      runtime.clickUpAddTaskComment(params.taskId.trim(), params.body.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.taskComments',
    permission: 'workspace',
    params: ClickUpTaskId,
    handler: async (params, { runtime }) =>
      runtime.clickUpTaskComments(params.taskId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listLists',
    permission: 'workspace',
    params: ClickUpListLists,
    handler: async (params, { runtime }) =>
      runtime.clickUpListLists(params?.workspaceId, params?.listId, params?.spaceId)
  }),
  defineMethod({
    name: 'clickup.listSpaces',
    permission: 'workspace',
    params: ClickUpWorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListSpaces(params?.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listMembers',
    permission: 'workspace',
    params: ClickUpWorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListMembers(params?.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listTags',
    permission: 'workspace',
    params: ClickUpWorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListTags(params?.workspaceId)
  })
]
