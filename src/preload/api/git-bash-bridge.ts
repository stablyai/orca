import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const gitBashApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('gitBash:isAvailable')
} satisfies PreloadApi['gitBash']
