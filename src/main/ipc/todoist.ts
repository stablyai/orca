import { ipcMain } from 'electron'
import {
  closeTodoistTask,
  connectTodoist,
  disconnectTodoist,
  getTodoistComments,
  getTodoistStatus,
  listTodoistTasks
} from '../todoist/todoist-client'

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value.trim()) ? value.trim() : null
}

function clampLimit(value: unknown, fallback = 100): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, Math.floor(limit)), 500)
}

/** Registers every `todoist:*` IPC handler on the main process. */
export function registerTodoistHandlers(): void {
  ipcMain.handle('todoist:connect', async (_event, args?: { apiToken?: unknown }) => {
    if (typeof args?.apiToken !== 'string') {
      return { ok: false, error: 'API token is required.' }
    }
    return connectTodoist(args.apiToken)
  })

  ipcMain.handle('todoist:disconnect', async () => disconnectTodoist())

  ipcMain.handle('todoist:status', async () => getTodoistStatus())

  ipcMain.handle(
    'todoist:listTasks',
    async (_event, args?: { query?: unknown; limit?: unknown }) => {
      const query = typeof args?.query === 'string' ? args.query.slice(0, 1024) : ''
      return listTodoistTasks(query, clampLimit(args?.limit))
    }
  )

  ipcMain.handle('todoist:getComments', async (_event, args?: { taskId?: unknown }) => {
    const taskId = normalizeId(args?.taskId)
    return taskId ? getTodoistComments(taskId) : []
  })

  ipcMain.handle('todoist:closeTask', async (_event, args?: { id?: unknown }) => {
    const id = normalizeId(args?.id)
    return id ? closeTodoistTask(id) : { ok: false, error: 'Invalid task id.' }
  })
}
