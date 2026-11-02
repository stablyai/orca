import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser-window-close-installation'
import { installBrowserWindowPrompt } from './browser-window-prompt-installation'
import type { ContextBridge, IpcRenderer } from 'electron'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'sendToHost'>
} = require('electron')
const { contextBridge, ipcRenderer } = electron

// Subframe window.close() is already inert; preserve the frame's own implementation.
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({
    func: installBrowserWindowCloseGuard,
    args: [() => ipcRenderer.sendToHost(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)]
  })
}
// Every frame this preload runs in also got Electron's throwing prompt.
contextBridge.executeInMainWorld({ func: installBrowserWindowPrompt, args: [] })
