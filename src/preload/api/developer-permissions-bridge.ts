import { ipcRenderer } from 'electron'

export const developerPermissionsApi = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('developerPermissions:getStatus'),
  request: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke('developerPermissions:request', args),
  openSettings: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke('developerPermissions:openSettings', args),
  testLocalNetworkConnection: (args: { host: string; port: number }): Promise<unknown> =>
    ipcRenderer.invoke('developerPermissions:testLocalNetworkConnection', args)
}
