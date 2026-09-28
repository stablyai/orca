import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const kiroUsageApi = {
  refresh: (force?: boolean): Promise<void> => ipcRenderer.invoke('kiroUsage:refresh', force)
} satisfies PreloadApi['kiroUsage']
