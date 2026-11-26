import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const collectionsApi = {
  list: () => ipcRenderer.invoke('collections:list'),
  create: (args) => ipcRenderer.invoke('collections:create', args),
  update: (args) => ipcRenderer.invoke('collections:update', args),
  delete: (args) => ipcRenderer.invoke('collections:delete', args)
} satisfies PreloadApi['collections']
