import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const multiRepoWorkspacesApi = {
  create: (args) => ipcRenderer.invoke('multiRepoWorkspaces:create', args),
  retryMember: (args) => ipcRenderer.invoke('multiRepoWorkspaces:retryMember', args),
  removeMember: (args) => ipcRenderer.invoke('multiRepoWorkspaces:removeMember', args),
  detachMember: (args) => ipcRenderer.invoke('multiRepoWorkspaces:detachMember', args),
  attachMember: (args) => ipcRenderer.invoke('multiRepoWorkspaces:attachMember', args),
  inspectDelete: (args) => ipcRenderer.invoke('multiRepoWorkspaces:inspectDelete', args),
  delete: (args) => ipcRenderer.invoke('multiRepoWorkspaces:delete', args)
} satisfies PreloadApi['multiRepoWorkspaces']
