import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'

export const claudeUsageApi = createUsageProviderApi(ipcRenderer, 'claudeUsage')
