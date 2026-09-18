import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const devinUsageApi = createUsageProviderApi(
  ipcRenderer,
  'devinUsage'
) satisfies PreloadApi['devinUsage']
