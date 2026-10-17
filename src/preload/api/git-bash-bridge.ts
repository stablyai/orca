import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const gitBashApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('gitBash:isAvailable')
} satisfies PreloadApi['gitBash']

export const cmderApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('cmder:isAvailable')
} satisfies PreloadApi['cmder']
