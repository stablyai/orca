import { ipcRenderer } from 'electron'

export const minimaxCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (cookie: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:clearCookie')
}
