import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const folderWorkspacesApi = {
  list: () => ipcRenderer.invoke('folderWorkspaces:list'),
  getPathStatus: (args) => ipcRenderer.invoke('folderWorkspaces:getPathStatus', args),
  create: (args) => ipcRenderer.invoke('folderWorkspaces:create', args),
  update: (args) => ipcRenderer.invoke('folderWorkspaces:update', args),
  delete: (args) => ipcRenderer.invoke('folderWorkspaces:delete', args)
} satisfies PreloadApi['folderWorkspaces']
