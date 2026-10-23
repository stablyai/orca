import { installBrowserWindowCloseGuard } from './browser-window-close-installation'
import type { ContextBridge } from 'electron'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const { contextBridge } = require('electron') as { contextBridge: ContextBridge }

// Why top frame only: extension-profile guests also run preloads in subframes, where
// window.close() already does nothing and a frozen close would only break a frame's own code.
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({ func: installBrowserWindowCloseGuard })
}
