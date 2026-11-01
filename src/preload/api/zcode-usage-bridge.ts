import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const zcodeUsageApi = createUsageProviderApi(
  ipcRenderer,
  'zcodeUsage'
) satisfies PreloadApi['zcodeUsage']
