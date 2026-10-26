import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const desktopAppApi = {
  listWindows: () => ipcRenderer.invoke('desktopApp:listWindows'),
  prepareCapture: (args) => ipcRenderer.invoke('desktopApp:prepareCapture', args),
  releaseCapture: (args) => ipcRenderer.invoke('desktopApp:releaseCapture', args),
  sendInput: (args) => ipcRenderer.invoke('desktopApp:sendInput', args)
} satisfies PreloadApi['desktopApp']
