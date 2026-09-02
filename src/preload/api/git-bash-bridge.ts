import { ipcRenderer } from 'electron'

export const gitBashApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('gitBash:isAvailable')
}
