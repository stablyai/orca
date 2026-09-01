import { ipcRenderer } from 'electron'

export const wslApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
  listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros')
}
