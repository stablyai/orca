import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const antigravityAccountsApi: PreloadApi['antigravityAccounts'] = {
  list: () => ipcRenderer.invoke('antigravityAccounts:list'),
  add: () => ipcRenderer.invoke('antigravityAccounts:add'),
  select: (args) => ipcRenderer.invoke('antigravityAccounts:select', args),
  remove: (args) => ipcRenderer.invoke('antigravityAccounts:remove', args)
}
