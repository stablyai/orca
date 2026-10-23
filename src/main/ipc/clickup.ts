import { BrowserWindow, ipcMain } from 'electron'
import { getClickUpRateLimitState, onClickUpRateLimitStateChange } from '../clickup/rate-limit'
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
import { _resetPreflightCache } from '../preflight/agent-detection'
import { asRecord } from '../clickup/json-record'
import { normalizeClickUpTaskScope } from '../clickup/task-scope'
import { isClickUpTaskFilter } from '../../shared/clickup-task-filter'
import type {
  ClickUpCreateTaskArgs,
  ClickUpTaskFilter,
  ClickUpTaskScope,
  ClickUpTaskUpdate,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function workspaceSelection(value: unknown): ClickUpWorkspaceSelection | undefined {
  return optionalString(value)
}

function clampLimit(value: unknown, fallback: number, max = 100): number {
  return Math.min(
    Math.max(1, typeof value === 'number' && Number.isFinite(value) ? value : fallback),
    max
  )
}

function validNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isFinite(item))
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isNullablePriority(value: unknown): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4)
  )
}

function isNullableDueDate(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
  )
}

function isNullableEstimate(value: unknown): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
}

function normalizeTaskUpdate(value: unknown): ClickUpTaskUpdate | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const { name, description, status, priority, dueDate, timeEstimate, assigneeIds, tagNames } =
    record
  if (
    !isOptionalString(name) ||
    !isOptionalString(description) ||
    !isOptionalString(status) ||
    !isNullablePriority(priority) ||
    !isNullableDueDate(dueDate) ||
    !isNullableEstimate(timeEstimate) ||
    (assigneeIds !== undefined && !validNumberArray(assigneeIds)) ||
    (tagNames !== undefined && !validStringArray(tagNames))
  ) {
    return null
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(timeEstimate !== undefined ? { timeEstimate } : {}),
    ...(assigneeIds !== undefined ? { assigneeIds } : {}),
    ...(tagNames !== undefined ? { tagNames } : {})
  }
}

export function registerClickUpHandlers(): void {
  // Why push: a paused ClickUp queue looks like a hang; every window shows the
  // countdown instead of a spinner that never explains itself.
  onClickUpRateLimitStateChange((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('clickup:rateLimitStateChanged', state)
      }
    }
  })
  ipcMain.handle('clickup:rateLimitState', () => getClickUpRateLimitState())

  ipcMain.handle('clickup:connect', async (_event, args: { apiToken: string }) => {
    if (typeof args?.apiToken !== 'string' || !args.apiToken.trim()) {
      return { ok: false, error: 'Personal API token is required.' }
    }
    const result = await connect(args.apiToken)
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('clickup:disconnect', async () => {
    disconnect()
    _resetPreflightCache()
  })

  ipcMain.handle(
    'clickup:selectWorkspace',
    async (_event, args: { workspaceId: ClickUpWorkspaceSelection }) => {
      const workspaceId = workspaceSelection(args?.workspaceId)
      return workspaceId ? selectWorkspace(workspaceId) : getStatus()
    }
  )

  ipcMain.handle('clickup:status', async () => getStatus())
  ipcMain.handle('clickup:testConnection', async () => testConnection())

  ipcMain.handle(
    'clickup:searchTasks',
    async (
      _event,
      args: {
        query: string
        limit?: number
        workspaceId?: ClickUpWorkspaceSelection
        scope?: ClickUpTaskScope
      }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchTasks(
        args.query,
        clampLimit(args.limit, 20),
        workspaceSelection(args.workspaceId),
        normalizeClickUpTaskScope(args.scope)
      )
    }
  )

  ipcMain.handle(
    'clickup:listTasks',
    async (
      _event,
      args?: {
        filter?: ClickUpTaskFilter
        limit?: number
        workspaceId?: ClickUpWorkspaceSelection
        scope?: ClickUpTaskScope
      }
    ) => {
      const filter = isClickUpTaskFilter(args?.filter) ? args?.filter : undefined
      return listTasks(
        filter,
        clampLimit(args?.limit, 50, 500),
        workspaceSelection(args?.workspaceId),
        normalizeClickUpTaskScope(args?.scope)
      )
    }
  )

  ipcMain.handle(
    'clickup:getTask',
    async (_event, args: { taskId: string; workspaceId?: string }) => {
      const taskId = optionalString(args?.taskId)
      return taskId ? getTask(taskId, optionalString(args.workspaceId)) : null
    }
  )

  ipcMain.handle('clickup:createTask', async (_event, args: ClickUpCreateTaskArgs) => {
    if (typeof args?.listId !== 'string' || !args.listId.trim()) {
      return { ok: false, error: 'List is required.' }
    }
    if (typeof args?.name !== 'string' || !args.name.trim()) {
      return { ok: false, error: 'Task name is required.' }
    }
    if (args.assigneeIds !== undefined && !validNumberArray(args.assigneeIds)) {
      return { ok: false, error: 'Invalid assignee IDs.' }
    }
    if (args.tagNames !== undefined && !validStringArray(args.tagNames)) {
      return { ok: false, error: 'Invalid tag names.' }
    }
    if (
      args.priority !== undefined &&
      args.priority !== null &&
      (!Number.isInteger(args.priority) || args.priority < 1 || args.priority > 4)
    ) {
      return { ok: false, error: 'Invalid priority.' }
    }
    if (
      args.dueDate !== undefined &&
      (typeof args.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate))
    ) {
      return { ok: false, error: 'Invalid due date.' }
    }
    if (
      args.timeEstimate !== undefined &&
      (!Number.isFinite(args.timeEstimate) || args.timeEstimate < 0)
    ) {
      return { ok: false, error: 'Invalid time estimate.' }
    }
    return createTask({
      ...args,
      listId: args.listId.trim(),
      name: args.name.trim(),
      workspaceId: optionalString(args.workspaceId),
      description: optionalString(args.description),
      status: optionalString(args.status),
      parentTaskId: optionalString(args.parentTaskId)
    })
  })

  ipcMain.handle(
    'clickup:updateTask',
    async (_event, args: { taskId: string; updates: ClickUpTaskUpdate; workspaceId?: string }) => {
      const taskId = optionalString(args?.taskId)
      if (!taskId) {
        return { ok: false, error: 'Task ID is required.' }
      }
      const updates = normalizeTaskUpdate(args.updates)
      return updates
        ? updateTask(taskId, updates, optionalString(args.workspaceId))
        : { ok: false, error: 'Invalid task updates.' }
    }
  )

  ipcMain.handle(
    'clickup:addTaskComment',
    async (_event, args: { taskId: string; body: string; workspaceId?: string }) => {
      const taskId = optionalString(args?.taskId)
      const body = optionalString(args?.body)
      if (!taskId || !body) {
        return { ok: false, error: 'Task ID and comment are required.' }
      }
      return addTaskComment(taskId, body, optionalString(args.workspaceId))
    }
  )

  ipcMain.handle(
    'clickup:taskComments',
    async (_event, args: { taskId: string; workspaceId?: string }) => {
      const taskId = optionalString(args?.taskId)
      return taskId ? getTaskComments(taskId, optionalString(args.workspaceId)) : []
    }
  )

  ipcMain.handle(
    'clickup:listLists',
    async (
      _event,
      args?: { workspaceId?: ClickUpWorkspaceSelection; listId?: string; spaceId?: string }
    ) =>
      listLists(
        workspaceSelection(args?.workspaceId),
        optionalString(args?.listId),
        optionalString(args?.spaceId)
      )
  )

  ipcMain.handle('clickup:listSpaces', async (_event, args?: { workspaceId?: string }) =>
    listSpaces(workspaceSelection(args?.workspaceId))
  )

  ipcMain.handle('clickup:listMembers', async (_event, args?: { workspaceId?: string }) =>
    listWorkspaceMembers(optionalString(args?.workspaceId))
  )

  ipcMain.handle('clickup:listTags', async (_event, args?: { workspaceId?: string }) =>
    listWorkspaceTags(optionalString(args?.workspaceId))
  )
}
