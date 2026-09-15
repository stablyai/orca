import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const kimiUsageApi = createUsageProviderApi(
  ipcRenderer,
  'kimiUsage'
) satisfies PreloadApi['kimiUsage']
