import { ipcRenderer } from 'electron'

export const pwshApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('pwsh:isAvailable')
}
