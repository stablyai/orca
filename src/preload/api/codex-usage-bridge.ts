import { ipcRenderer } from 'electron'
import { createUsageProviderApi } from '../usage-provider-api'

export const codexUsageApi = createUsageProviderApi(ipcRenderer, 'codexUsage')
