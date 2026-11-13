import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const appIconApi = {
  importCustom: () => ipcRenderer.invoke('appIcon:importCustom'),
  readCustomPreview: () => ipcRenderer.invoke('appIcon:readCustomPreview'),
  removeCustom: () => ipcRenderer.invoke('appIcon:removeCustom')
} satisfies PreloadApi['appIcon']
