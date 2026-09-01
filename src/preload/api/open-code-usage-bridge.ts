import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'

export const openCodeUsageApi = createUsageProviderApi(ipcRenderer, 'openCodeUsage')
