import { ipcRenderer } from 'electron'
import type { FactoryAccountsApi } from './agent-account-api'

export const factoryAccountsApi: FactoryAccountsApi = {
  getStatus: () => ipcRenderer.invoke('factoryAccounts:getStatus'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('factoryAccounts:saveApiKey', apiKey),
  clearApiKey: () => ipcRenderer.invoke('factoryAccounts:clearApiKey')
}
