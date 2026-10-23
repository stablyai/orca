import {
  createBrowserWindowCloseRequest,
  installBrowserWindowCloseGuard
} from './browser-window-close-installation'
import type { ContextBridge, IpcRenderer } from 'electron'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a sandboxed preload's require('electron') exposes contextBridge and ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: ContextBridge
  ipcRenderer: IpcRenderer
}

contextBridge.executeInMainWorld({
  func: installBrowserWindowCloseGuard,
  args: [createBrowserWindowCloseRequest((channel) => ipcRenderer.sendToHost(channel))]
})
