import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const claudeUsageApi = {
  ...createUsageProviderApi(ipcRenderer, 'claudeUsage'),
  getStatsCache: () => ipcRenderer.invoke('claudeUsage:getStatsCache')
} satisfies PreloadApi['claudeUsage']
