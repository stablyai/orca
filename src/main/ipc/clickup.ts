import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../clickup/client'
import {
  addTaskComment,
  createTask,
  getTask,
  getTaskComments,
  listLists,
  listTasks,
  listWorkspaceMembers,
  listWorkspaceTags,
  searchTasks,
  updateTask
} from '../clickup/tasks'
import { _resetPreflightCache } from './preflight'
import type { ClickUpCreateTaskArgs, ClickUpTaskFilter, ClickUpTaskUpdate, ClickUpWorkspaceSelection } from '../../shared/clickup-types'
const VALID_FILTERS = new Set<ClickUpTaskFilter>([
  'assigned',
  'created',
  'all',
  'completed',
  'open'
])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function workspaceSelection(value: unknown): ClickUpWorkspaceSelection | undefined {
  return optionalString(value) as ClickUpWorkspaceSelection | undefined
}

function clampLimit(value: unknown, fallback: number): number {
  return Math.min(
    Math.max(1, typeof value === 'number' && Number.isFinite(value) ? value : fallback),
    100
  )
}

function validNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isFinite(item))
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function normalizeTaskUpdate(value: unknown): ClickUpTaskUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const update = value as ClickUpTaskUpdate
  if (update.name !== undefined && typeof update.name !== 'string') {
    return null
  }
  if (update.description !== undefined && typeof update.description !== 'string') {
    return null
  }
  if (update.status !== undefined && typeof update.status !== 'string') {
    return null
  }
  if (
    update.priority !== undefined &&
    update.priority !== null &&
    (!Number.isInteger(update.priority) || update.priority < 1 || update.priority > 4)
  ) {
    return null
  }
  if (
    update.dueDate !== undefined &&
    update.dueDate !== null &&
    (typeof update.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(update.dueDate))
  ) {
    return null
  }
  if (
    update.timeEstimate !== undefined &&
    update.timeEstimate !== null &&
    (!Number.isFinite(update.timeEstimate) || update.timeEstimate < 0)
  ) {
    return null
  }
  if (update.assigneeIds !== undefined && !validNumberArray(update.assigneeIds)) {
    return null
  }
  if (update.tagNames !== undefined && !validStringArray(update.tagNames)) {
    return null
  }
  return update
}

export function registerClickUpHandlers(): void {
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
      args: { query: string; limit?: number; workspaceId?: ClickUpWorkspaceSelection }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchTasks(
        args.query,
        clampLimit(args.limit, 20),
        workspaceSelection(args.workspaceId)
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
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as ClickUpTaskFilter)
        ? (args!.filter as ClickUpTaskFilter)
        : undefined
      return listTasks(filter, clampLimit(args?.limit, 50), workspaceSelection(args?.workspaceId))
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
    async (_event, args?: { workspaceId?: ClickUpWorkspaceSelection }) =>
      listLists(workspaceSelection(args?.workspaceId))
  )

  ipcMain.handle('clickup:listMembers', async (_event, args?: { workspaceId?: string }) =>
    listWorkspaceMembers(optionalString(args?.workspaceId))
  )

  ipcMain.handle('clickup:listTags', async (_event, args?: { workspaceId?: string }) =>
    listWorkspaceTags(optionalString(args?.workspaceId))
  )
}
