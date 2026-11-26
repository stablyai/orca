import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const projectsApi = {
  setupFolderReplica: (args) => ipcRenderer.invoke('projectHostSetups:setupFolderReplica', args),
  getFolderSyncStatus: (args) => ipcRenderer.invoke('projectHostSetups:getFolderSyncStatus', args),
  setFolderSyncPreference: (args) =>
    ipcRenderer.invoke('projectHostSetups:setFolderSyncPreference', args),
  list: () => ipcRenderer.invoke('projects:list'),
  update: (args) => ipcRenderer.invoke('projects:update', args),
  listHostSetups: () => ipcRenderer.invoke('projectHostSetups:list'),
  createHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:create', args),
  setupExistingFolder: (args) => ipcRenderer.invoke('projectHostSetups:setupExistingFolder', args),
  updateHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:update', args),
  deleteHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:delete', args)
} satisfies PreloadApi['projects']
