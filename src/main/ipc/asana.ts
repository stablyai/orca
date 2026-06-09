import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../asana/client'
import { _resetPreflightCache } from './preflight'
import {
  addTaskComment,
  createTask,
  getTask,
  getTaskComments,
  listAssignableUsers,
  listProjects,
  listSections,
  listTasks,
  searchTasks,
  updateTask
} from '../asana/issues'
import type {
  AsanaConnectArgs,
  AsanaCreateTaskArgs,
  AsanaTaskFilter,
  AsanaTaskUpdate,
  AsanaWorkspaceSelection
} from '../../shared/types'

const VALID_FILTERS = new Set<AsanaTaskFilter>(['assigned', 'all', 'done'])

function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceSelection(value: unknown): AsanaWorkspaceSelection | undefined {
  const workspaceId = normalizeWorkspaceId(value)
  return workspaceId as AsanaWorkspaceSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeTaskUpdate(value: unknown): AsanaTaskUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as AsanaTaskUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.notes !== undefined && typeof input.notes !== 'string') {
    return null
  }
  if (input.completed !== undefined && typeof input.completed !== 'boolean') {
    return null
  }
  if (
    input.assigneeGid !== undefined &&
    input.assigneeGid !== null &&
    typeof input.assigneeGid !== 'string'
  ) {
    return null
  }
  if (input.dueOn !== undefined && input.dueOn !== null && typeof input.dueOn !== 'string') {
    return null
  }
  return input
}

export function registerAsanaHandlers(): void {
  ipcMain.handle('asana:connect', async (_event, args: AsanaConnectArgs) => {
    if (typeof args?.apiToken !== 'string') {
      return { ok: false, error: 'A Personal Access Token is required.' }
    }
    const result = await connect({ apiToken: args.apiToken })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('asana:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  ipcMain.handle(
    'asana:selectWorkspace',
    async (_event, args: { workspaceId: AsanaWorkspaceSelection }) => {
      const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
      if (!workspaceId) {
        return getStatus()
      }
      return selectWorkspace(workspaceId)
    }
  )

  ipcMain.handle('asana:status', async () => {
    return getStatus()
  })

  ipcMain.handle('asana:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  ipcMain.handle(
    'asana:searchTasks',
    async (
      _event,
      args: { query: string; limit?: number; workspaceId?: AsanaWorkspaceSelection }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchTasks(
        args.query,
        clampLimit(args.limit),
        normalizeWorkspaceSelection(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'asana:listTasks',
    async (
      _event,
      args?: {
        filter?: AsanaTaskFilter
        limit?: number
        workspaceId?: AsanaWorkspaceSelection
        projectId?: string
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as AsanaTaskFilter)
        ? (args!.filter as AsanaTaskFilter)
        : undefined
      return listTasks(
        filter,
        clampLimit(args?.limit),
        normalizeWorkspaceSelection(args?.workspaceId),
        normalizeWorkspaceId(args?.projectId)
      )
    }
  )

  ipcMain.handle('asana:getTask', async (_event, args: { gid: string; workspaceId?: string }) => {
    if (typeof args?.gid !== 'string' || !args.gid.trim()) {
      return null
    }
    return getTask(args.gid.trim(), normalizeWorkspaceSelection(args.workspaceId))
  })

  ipcMain.handle('asana:createTask', async (_event, args: AsanaCreateTaskArgs) => {
    if (typeof args?.title !== 'string' || !args.title.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    return createTask({
      workspaceId: normalizeWorkspaceId(args.workspaceId),
      projectId: normalizeWorkspaceId(args.projectId),
      title: args.title.trim(),
      notes: typeof args.notes === 'string' ? args.notes : undefined,
      assigneeGid: normalizeWorkspaceId(args.assigneeGid)
    })
  })

  ipcMain.handle(
    'asana:updateTask',
    async (_event, args: { gid: string; updates: AsanaTaskUpdate; workspaceId?: string }) => {
      if (typeof args?.gid !== 'string' || !args.gid.trim()) {
        return { ok: false, error: 'Task id is required.' }
      }
      const updates = normalizeTaskUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateTask(args.gid.trim(), updates, normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'asana:addTaskComment',
    async (_event, args: { gid: string; text: string; workspaceId?: string }) => {
      if (typeof args?.gid !== 'string' || !args.gid.trim()) {
        return { ok: false, error: 'Task id is required.' }
      }
      if (typeof args?.text !== 'string' || !args.text.trim()) {
        return { ok: false, error: 'Comment text is required.' }
      }
      return addTaskComment(
        args.gid.trim(),
        args.text.trim(),
        normalizeWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'asana:taskComments',
    async (_event, args: { gid: string; workspaceId?: string }) => {
      if (typeof args?.gid !== 'string' || !args.gid.trim()) {
        return []
      }
      return getTaskComments(args.gid.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'asana:listProjects',
    async (_event, args?: { workspaceId?: AsanaWorkspaceSelection }) => {
      return listProjects(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle(
    'asana:listSections',
    async (_event, args: { projectGid: string; workspaceId?: string }) => {
      if (typeof args?.projectGid !== 'string' || !args.projectGid.trim()) {
        return []
      }
      return listSections(args.projectGid.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'asana:listAssignableUsers',
    async (_event, args?: { workspaceId?: string; query?: string }) => {
      return listAssignableUsers(
        normalizeWorkspaceId(args?.workspaceId),
        typeof args?.query === 'string' ? args.query : undefined
      )
    }
  )
}
