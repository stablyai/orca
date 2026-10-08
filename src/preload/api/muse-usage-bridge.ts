import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const museUsageApi = createUsageProviderApi(
  ipcRenderer,
  'museUsage'
) satisfies PreloadApi['museUsage']
