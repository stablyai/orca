import type {
  ClickUpCreateTaskArgs,
  ClickUpTaskFilter,
  ClickUpTaskScope,
  ClickUpTaskUpdate,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../clickup/client'
import {
  addTaskComment,
  createTask,
  getTask,
  getTaskComments,
  listLists,
  listSpaces,
  listTasks,
  listWorkspaceMembers,
  listWorkspaceTags,
  searchTasks,
  updateTask
} from '../clickup/tasks'
import { normalizeClickUpTaskScope } from '../clickup/task-scope'

function clampLimit(limit: number, max = 100): number {
  return Math.min(Math.max(1, limit), max)
}

// Why: mirrors RuntimeJiraCommands so the edge controller can bind every
// `clickUp*` method onto the runtime surface without touching the core class.
export class RuntimeClickUpCommands {
  clickUpConnect(apiToken: string): ReturnType<typeof connect> {
    return connect(apiToken)
  }

  clickUpDisconnect(): { ok: true } {
    disconnect()
    return { ok: true }
  }

  clickUpSelectWorkspace(workspaceId: ClickUpWorkspaceSelection): ReturnType<typeof getStatus> {
    return selectWorkspace(workspaceId)
  }

  clickUpStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  clickUpTestConnection(): ReturnType<typeof testConnection> {
    return testConnection()
  }

  clickUpSearchTasks(
    query: string,
    limit = 20,
    workspaceId?: ClickUpWorkspaceSelection,
    scope?: ClickUpTaskScope
  ): ReturnType<typeof searchTasks> {
    return searchTasks(query, clampLimit(limit), workspaceId, normalizeClickUpTaskScope(scope))
  }

  clickUpListTasks(
    filter?: ClickUpTaskFilter,
    limit = 50,
    workspaceId?: ClickUpWorkspaceSelection,
    scope?: ClickUpTaskScope
  ): ReturnType<typeof listTasks> {
    const taskScope = normalizeClickUpTaskScope(scope)
    return listTasks(filter, clampLimit(limit, taskScope ? 500 : 100), workspaceId, taskScope)
  }

  clickUpGetTask(taskId: string, workspaceId?: string): ReturnType<typeof getTask> {
    return getTask(taskId, workspaceId)
  }

  clickUpCreateTask(args: ClickUpCreateTaskArgs): ReturnType<typeof createTask> {
    return createTask(args)
  }

  clickUpUpdateTask(
    taskId: string,
    updates: ClickUpTaskUpdate,
    workspaceId?: string
  ): ReturnType<typeof updateTask> {
    return updateTask(taskId, updates, workspaceId)
  }

  clickUpAddTaskComment(
    taskId: string,
    body: string,
    workspaceId?: string
  ): ReturnType<typeof addTaskComment> {
    return addTaskComment(taskId, body, workspaceId)
  }

  clickUpTaskComments(taskId: string, workspaceId?: string): ReturnType<typeof getTaskComments> {
    return getTaskComments(taskId, workspaceId)
  }

  clickUpListLists(
    workspaceId?: ClickUpWorkspaceSelection,
    listId?: string,
    spaceId?: string
  ): ReturnType<typeof listLists> {
    return listLists(workspaceId, listId, spaceId)
  }

  clickUpListSpaces(workspaceId?: ClickUpWorkspaceSelection): ReturnType<typeof listSpaces> {
    return listSpaces(workspaceId)
  }

  clickUpListMembers(workspaceId?: string): ReturnType<typeof listWorkspaceMembers> {
    return listWorkspaceMembers(workspaceId)
  }

  clickUpListTags(workspaceId?: string): ReturnType<typeof listWorkspaceTags> {
    return listWorkspaceTags(workspaceId)
  }
}
