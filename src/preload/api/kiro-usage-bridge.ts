import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

/** Renderer -> main bridge for the Kiro `/usage` read. */
export const kiroUsageApi = {
  refresh: (force?: boolean): Promise<void> => ipcRenderer.invoke('kiroUsage:refresh', force)
} satisfies PreloadApi['kiroUsage']
