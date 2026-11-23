import { ipcMain } from 'electron'
import {
  normalizeClickUpPage,
  normalizeClickUpTaskListFilter
} from '../../../shared/clickup/clickup-task-filter'
import { taskProviderFailure } from '../../../shared/work-items/task-provider-failure'
import {
  connect,
  disconnect,
  getStatus,
  selectWorkspace,
  testConnection
} from '../../clickup/client'
import { addTaskComment, updateTask } from '../../clickup/clickup-task-mutations'
import {
  getTask,
  getTaskComments,
  listStatuses,
  listTasks,
  searchTasks
} from '../../clickup/clickup-task-queries'
import { _resetPreflightCache } from '../../preflight/agent-detection'
import { normalizeClickUpString, normalizeClickUpTaskUpdate } from './ipc-params'

type TaskIdArgs = { id?: unknown }

export function registerClickUpHandlers(): void {
  ipcMain.handle('clickup:connect', async (_event, args?: { token?: unknown }) => {
    const token = normalizeClickUpString(args?.token)
    if (!token) {
      return taskProviderFailure('clickup.tokenRequired', 'Personal API token is required.')
    }
    const result = await connect(token)
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('clickup:disconnect', async () => {
    await disconnect()
    _resetPreflightCache()
  })

  ipcMain.handle('clickup:selectWorkspace', async (_event, args?: { workspaceId?: unknown }) => {
    const workspaceId = normalizeClickUpString(args?.workspaceId)
    return workspaceId ? selectWorkspace(workspaceId) : getStatus()
  })

  ipcMain.handle('clickup:status', () => getStatus())

  ipcMain.handle('clickup:testConnection', () => testConnection())

  ipcMain.handle('clickup:listTasks', (_event, args?: { filter?: unknown; page?: unknown }) =>
    listTasks(normalizeClickUpTaskListFilter(args?.filter), normalizeClickUpPage(args?.page))
  )

  ipcMain.handle('clickup:searchTasks', (_event, args?: { query?: unknown; filter?: unknown }) => {
    const query = normalizeClickUpString(args?.query)
    return query ? searchTasks(query, normalizeClickUpTaskListFilter(args?.filter)) : []
  })

  ipcMain.handle('clickup:getTask', (_event, args?: TaskIdArgs) =>
    getTask(normalizeClickUpString(args?.id))
  )

  ipcMain.handle('clickup:taskComments', (_event, args?: TaskIdArgs) =>
    getTaskComments(normalizeClickUpString(args?.id))
  )

  ipcMain.handle('clickup:addTaskComment', (_event, args?: TaskIdArgs & { body?: unknown }) =>
    addTaskComment(
      normalizeClickUpString(args?.id),
      typeof args?.body === 'string' ? args.body : ''
    )
  )

  ipcMain.handle('clickup:listStatuses', (_event, args?: { listId?: unknown }) => {
    const listId = normalizeClickUpString(args?.listId)
    return listId ? listStatuses(listId) : []
  })

  ipcMain.handle('clickup:updateTask', (_event, args?: TaskIdArgs & { updates?: unknown }) =>
    updateTask(normalizeClickUpString(args?.id), normalizeClickUpTaskUpdate(args?.updates))
  )
}
