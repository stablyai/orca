import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const clickupApi = {
  connect: (args) => ipcRenderer.invoke('clickup:connect', args),
  disconnect: () => ipcRenderer.invoke('clickup:disconnect'),
  selectWorkspace: (args) => ipcRenderer.invoke('clickup:selectWorkspace', args),
  status: () => ipcRenderer.invoke('clickup:status'),
  testConnection: () => ipcRenderer.invoke('clickup:testConnection'),
  listTasks: (args) => ipcRenderer.invoke('clickup:listTasks', args),
  searchTasks: (args) => ipcRenderer.invoke('clickup:searchTasks', args),
  cancelSearchTasks: (args) => ipcRenderer.invoke('clickup:cancelSearchTasks', args),
  getTask: (args) => ipcRenderer.invoke('clickup:getTask', args),
  taskComments: (args) => ipcRenderer.invoke('clickup:taskComments', args),
  addTaskComment: (args) => ipcRenderer.invoke('clickup:addTaskComment', args),
  listStatuses: (args) => ipcRenderer.invoke('clickup:listStatuses', args),
  updateTask: (args) => ipcRenderer.invoke('clickup:updateTask', args)
} satisfies PreloadApi['clickup']
