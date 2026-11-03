import { ipcRenderer } from 'electron'
import type { ClickUpRateLimitState } from '../../shared/clickup-types'
import type { PreloadApi } from '../api-types'

export const clickUpApi = {
  connect: (args) => ipcRenderer.invoke('clickup:connect', args),

  disconnect: () => ipcRenderer.invoke('clickup:disconnect'),

  selectWorkspace: (args) => ipcRenderer.invoke('clickup:selectWorkspace', args),

  status: () => ipcRenderer.invoke('clickup:status'),

  testConnection: () => ipcRenderer.invoke('clickup:testConnection'),

  searchTasks: (args) => ipcRenderer.invoke('clickup:searchTasks', args),

  listTasks: (args) => ipcRenderer.invoke('clickup:listTasks', args),

  getTask: (args) => ipcRenderer.invoke('clickup:getTask', args),

  createTask: (args) => ipcRenderer.invoke('clickup:createTask', args),

  updateTask: (args) => ipcRenderer.invoke('clickup:updateTask', args),

  addTaskComment: (args) => ipcRenderer.invoke('clickup:addTaskComment', args),

  taskComments: (args) => ipcRenderer.invoke('clickup:taskComments', args),

  listLists: (args) => ipcRenderer.invoke('clickup:listLists', args),

  listSpaces: (args) => ipcRenderer.invoke('clickup:listSpaces', args),

  listMembers: (args) => ipcRenderer.invoke('clickup:listMembers', args),

  listTags: (args) => ipcRenderer.invoke('clickup:listTags', args),

  rateLimitState: () => ipcRenderer.invoke('clickup:rateLimitState'),

  onRateLimitStateChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ClickUpRateLimitState): void =>
      callback(state)
    ipcRenderer.on('clickup:rateLimitStateChanged', listener)
    return () => {
      ipcRenderer.removeListener('clickup:rateLimitStateChanged', listener)
    }
  }
} satisfies PreloadApi['clickup']
