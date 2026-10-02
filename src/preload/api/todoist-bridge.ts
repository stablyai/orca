import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const todoistApi = {
  connect: (args: { apiToken: string }) => ipcRenderer.invoke('todoist:connect', args),
  disconnect: () => ipcRenderer.invoke('todoist:disconnect'),
  status: () => ipcRenderer.invoke('todoist:status'),
  listTasks: (args?: { query?: string; limit?: number }) =>
    ipcRenderer.invoke('todoist:listTasks', args),
  getComments: (args: { taskId: string }) => ipcRenderer.invoke('todoist:getComments', args),
  closeTask: (args: { id: string }) => ipcRenderer.invoke('todoist:closeTask', args)
} satisfies PreloadApi['todoist']
