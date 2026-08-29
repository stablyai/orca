import { ipcMain } from 'electron'
import { _resetPreflightCache } from './preflight'
import {
  connect,
  connectFromSavedCredentials,
  disconnect,
  getStatus,
  loginWithGoogle,
  testConnection
} from '../volo/client'
import {
  createTask,
  getTask,
  listBoards,
  listMembers,
  listTasks,
  moveTask,
  updateTask
} from '../volo/tasks'
import type {
  VoloConnectArgs,
  VoloCreateTaskArgs,
  VoloTaskFilter,
  VoloTaskUpdate
} from '../../shared/volo-types'
import { isVoloPriority, isVoloTaskFilter } from '../../shared/volo-types'

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function registerVoloHandlers(): void {
  ipcMain.handle('volo:connect', async (_event, args: VoloConnectArgs) => {
    if (typeof args?.apiToken !== 'string' || !args.apiToken.trim()) {
      return { ok: false, error: 'API token is required.' }
    }
    const result = await connect({
      apiToken: args.apiToken,
      apiUrl: asNonEmptyString(args.apiUrl) ?? undefined,
      webUrl: asNonEmptyString(args.webUrl) ?? undefined
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('volo:connectFromSavedCredentials', async () => {
    const result = await connectFromSavedCredentials()
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('volo:loginWithGoogle', async (_event, args?: { apiUrl?: string }) => {
    const result = await loginWithGoogle(asNonEmptyString(args?.apiUrl) ?? undefined)
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('volo:disconnect', async () => {
    disconnect()
    _resetPreflightCache()
    return { ok: true }
  })

  ipcMain.handle('volo:status', async () => getStatus())
  ipcMain.handle('volo:readStatus', async () => getStatus())
  ipcMain.handle('volo:testConnection', async () => testConnection())

  ipcMain.handle('volo:listBoards', async () => listBoards())
  ipcMain.handle('volo:listMembers', async (_event, args: { boardId?: string }) => {
    const boardId = asNonEmptyString(args?.boardId)
    return boardId ? listMembers(boardId) : []
  })
  ipcMain.handle(
    'volo:listTasks',
    async (_event, args: { boardId?: string; filter?: VoloTaskFilter }) => {
      const boardId = asNonEmptyString(args?.boardId)
      const filter = isVoloTaskFilter(args?.filter) ? args.filter : 'all'
      if (!boardId && filter !== 'assigned') {
        return []
      }
      return listTasks(boardId ?? '', filter)
    }
  )
  ipcMain.handle('volo:getTask', async (_event, args: { taskCode?: string }) => {
    const taskCode = asNonEmptyString(args?.taskCode)
    return taskCode ? getTask(taskCode) : null
  })
  ipcMain.handle('volo:createTask', async (_event, args: VoloCreateTaskArgs) => {
    const boardId = asNonEmptyString(args?.boardId)
    const title = asNonEmptyString(args?.title)
    const columnId = asNonEmptyString(args?.columnId)
    if (!boardId || !title || !columnId) {
      return { ok: false, error: 'Board, title, and column are required.' }
    }
    return createTask({
      boardId,
      title,
      columnId,
      description: asNonEmptyString(args.description) ?? undefined,
      priority: isVoloPriority(args.priority) ? args.priority : undefined,
      assigneeId: asNonEmptyString(args.assigneeId)
    })
  })
  ipcMain.handle(
    'volo:updateTask',
    async (_event, args: { boardId?: string; taskId?: string; updates?: VoloTaskUpdate }) => {
      const boardId = asNonEmptyString(args?.boardId)
      const taskId = asNonEmptyString(args?.taskId)
      if (!boardId || !taskId || !args?.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Board, task, and updates are required.' }
      }
      return updateTask(boardId, taskId, args.updates)
    }
  )
  ipcMain.handle(
    'volo:moveTask',
    async (_event, args: { boardId?: string; taskId?: string; columnId?: string }) => {
      const boardId = asNonEmptyString(args?.boardId)
      const taskId = asNonEmptyString(args?.taskId)
      const columnId = asNonEmptyString(args?.columnId)
      if (!boardId || !taskId || !columnId) {
        return { ok: false, error: 'Board, task, and column are required.' }
      }
      return moveTask(boardId, taskId, columnId)
    }
  )
}
