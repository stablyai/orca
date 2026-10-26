import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { DesktopAppAgentActivity } from '../../shared/desktop-app-types'

export const desktopAppApi = {
  listWindows: () => ipcRenderer.invoke('desktopApp:listWindows'),
  prepareCapture: (args) => ipcRenderer.invoke('desktopApp:prepareCapture', args),
  releaseCapture: (args) => ipcRenderer.invoke('desktopApp:releaseCapture', args),
  sendInput: (args) => ipcRenderer.invoke('desktopApp:sendInput', args),
  onAgentActivity: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, activity: DesktopAppAgentActivity) =>
      callback(activity)
    ipcRenderer.on('desktopApp:agentActivity', listener)
    return () => ipcRenderer.removeListener('desktopApp:agentActivity', listener)
  },
  stopAgent: (args) => ipcRenderer.invoke('desktopApp:stopAgent', args),
  allowAgent: (args) => ipcRenderer.invoke('desktopApp:allowAgent', args),
  isAgentBlocked: (args) => ipcRenderer.invoke('desktopApp:isAgentBlocked', args)
} satisfies PreloadApi['desktopApp']
