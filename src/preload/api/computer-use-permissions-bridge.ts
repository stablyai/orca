import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const computerUsePermissionsApi = {
  getStatus: () => ipcRenderer.invoke('computerUsePermissions:getStatus'),
  openSetup: (args?: { id?: string }) =>
    ipcRenderer.invoke('computerUsePermissions:openSetup', args),
  reset: () => ipcRenderer.invoke('computerUsePermissions:reset')
} satisfies PreloadApi['computerUsePermissions']
