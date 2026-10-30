import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const openCodeUsageApi = createUsageProviderApi(
  ipcRenderer,
  'openCodeUsage'
) satisfies PreloadApi['openCodeUsage']
