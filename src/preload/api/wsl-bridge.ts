import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const wslApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
  listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros')
} satisfies PreloadApi['wsl']
