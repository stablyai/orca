import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const perforceApi = {
  run: (operation, args) => ipcRenderer.invoke('perforce:run', operation, args),
  detectFolder: (args) => ipcRenderer.invoke('perforce:detectFolder', args),
  generateDescription: (args) => ipcRenderer.invoke('perforce:generateDescription', args),
  runCopy: (operation, args) => ipcRenderer.invoke('perforce:runCopy', operation, args)
} satisfies PreloadApi['perforce']
