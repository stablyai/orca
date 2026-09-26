import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const perforceApi = {
  detect: (args) => ipcRenderer.invoke('perforce:detect', args),
  status: (args) => ipcRenderer.invoke('perforce:status', args),
  history: (args) => ipcRenderer.invoke('perforce:history', args),
  open: (args) => ipcRenderer.invoke('perforce:open', args),
  close: (args) => ipcRenderer.invoke('perforce:close', args),
  discard: (args) => ipcRenderer.invoke('perforce:discard', args),
  submit: (args) => ipcRenderer.invoke('perforce:submit', args),
  sync: (args) => ipcRenderer.invoke('perforce:sync', args),
  shelve: (args) => ipcRenderer.invoke('perforce:shelve', args),
  createChangelist: (args) => ipcRenderer.invoke('perforce:createChangelist', args),
  moveToChangelist: (args) => ipcRenderer.invoke('perforce:moveToChangelist', args),
  deleteChangelist: (args) => ipcRenderer.invoke('perforce:deleteChangelist', args)
} satisfies PreloadApi['perforce']
