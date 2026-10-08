import { ipcRenderer } from 'electron'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewEvent
} from '../../shared/desktop-browser-view-protocol'

export const desktopBrowserViewApi: DesktopBrowserViewApi = {
  create: (args) => ipcRenderer.invoke('browser:desktop-view:create', args),
  updateLayout: (args) => ipcRenderer.invoke('browser:desktop-view:layout', args),
  command: (args) => ipcRenderer.invoke('browser:desktop-view:command', args),
  input: (args) => ipcRenderer.invoke('browser:desktop-view:input', args),
  captureViewport: (args) => ipcRenderer.invoke('browser:desktop-view:capture-viewport', args),
  close: (args) => ipcRenderer.invoke('browser:desktop-view:close', args),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, event: DesktopBrowserViewEvent): void =>
      listener(event)
    ipcRenderer.on('browser:desktop-view:event', receive)
    return () => ipcRenderer.removeListener('browser:desktop-view:event', receive)
  }
}
