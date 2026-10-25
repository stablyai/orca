import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser-window-close-installation'
import type { ContextBridge, IpcRenderer } from 'electron'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'sendToHost'>
} = require('electron')
const { contextBridge, ipcRenderer } = electron

contextBridge.executeInMainWorld({
  func: installBrowserWindowCloseGuard,
  args: [() => ipcRenderer.sendToHost(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)]
})
