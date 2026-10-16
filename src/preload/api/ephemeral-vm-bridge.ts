import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const ephemeralVmApi = {
  listRecipes: (args) => ipcRenderer.invoke('ephemeralVm:listRecipes', args),
  listRecipeCatalog: (args) => ipcRenderer.invoke('ephemeralVm:listRecipeCatalog', args),
  doctor: (args) => ipcRenderer.invoke('ephemeralVm:doctor', args),
  provision: (args) => ipcRenderer.invoke('ephemeralVm:provision', args),
  adoptProvisionedRoot: (args) => ipcRenderer.invoke('ephemeralVm:adoptProvisionedRoot', args),
  cancelProvision: (args) => ipcRenderer.invoke('ephemeralVm:cancelProvision', args),
  onProvisionEvent: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }
    ): void => callback(event)
    ipcRenderer.on('ephemeralVm:provisionEvent', listener)
    return () => ipcRenderer.removeListener('ephemeralVm:provisionEvent', listener)
  },
  listRuntimes: (args) => ipcRenderer.invoke('ephemeralVm:listRuntimes', args),
  attachWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:attachWorkspace', args),
  suspendWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:suspendWorkspace', args),
  resumeWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:resumeWorkspace', args),
  cleanup: (args) => ipcRenderer.invoke('ephemeralVm:cleanup', args),
  stopCleanup: (args) => ipcRenderer.invoke('ephemeralVm:stopCleanup', args),
  getCleanupCommand: (args) => ipcRenderer.invoke('ephemeralVm:getCleanupCommand', args)
} satisfies PreloadApi['ephemeralVm']
