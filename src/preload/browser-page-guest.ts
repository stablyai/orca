import { installBrowserWindowCloseGuard } from './browser-window-close-installation'
import { installOffscreenPageGuest } from './offscreen-page-guest'
import type { ContextBridge, IpcRenderer } from 'electron'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: require('electron') in a preload is Electron's renderer module, which has both members.
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: ContextBridge
  ipcRenderer: IpcRenderer
}

contextBridge.executeInMainWorld({ func: installBrowserWindowCloseGuard })
installOffscreenPageGuest(ipcRenderer, (func) => contextBridge.executeInMainWorld({ func }))
