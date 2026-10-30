import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser-window-close-installation'
import type { ContextBridge, IpcRenderer } from 'electron'
import { installBrowserHistoryWheel } from './browser-history-wheel'

// Sandboxed preloads cannot require the main build's shared chunks.
const BROWSER_HISTORY_GESTURE_CHANNEL = 'browser:history-gesture'
const BROWSER_HISTORY_WHEEL_CHANNEL = 'browser:history-wheel'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: IpcRenderer
} = require('electron')
const { contextBridge, ipcRenderer } = electron

// Subframe window.close() is already inert; preserve the frame's own implementation.
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({
    func: installBrowserWindowCloseGuard,
    args: [() => ipcRenderer.sendToHost(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)]
  })
}

if (process.platform === 'darwin') {
  installBrowserHistoryWheel(
    (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, gestureId: unknown): void => {
        callback(
          typeof gestureId === 'number' && Number.isSafeInteger(gestureId) ? gestureId : null
        )
      }
      ipcRenderer.on(BROWSER_HISTORY_GESTURE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(BROWSER_HISTORY_GESTURE_CHANNEL, listener)
    },
    (wheel) => ipcRenderer.send(BROWSER_HISTORY_WHEEL_CHANNEL, wheel)
  )
}
