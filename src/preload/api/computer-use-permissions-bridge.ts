import { ipcRenderer } from 'electron'

export const computerUsePermissionsApi = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('computerUsePermissions:getStatus'),
  openSetup: (args?: { id?: string }): Promise<unknown> =>
    ipcRenderer.invoke('computerUsePermissions:openSetup', args),
  reset: (): Promise<unknown> => ipcRenderer.invoke('computerUsePermissions:reset')
}
