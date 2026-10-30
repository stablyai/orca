import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const ompUsageApi = createUsageProviderApi(
  ipcRenderer,
  'ompUsage'
) satisfies PreloadApi['ompUsage']
