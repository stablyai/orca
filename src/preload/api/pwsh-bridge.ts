import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const pwshApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('pwsh:isAvailable')
} satisfies PreloadApi['pwsh']
