import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const piUsageApi = createUsageProviderApi(
  ipcRenderer,
  'piUsage'
) satisfies PreloadApi['piUsage']
