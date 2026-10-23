import { installBrowserWindowCloseGuard } from './browser-window-close-installation'
import type { ContextBridge } from 'electron'

// Raw require keeps the sandboxed preload standalone in the CJS build.
const { contextBridge } = require('electron') as { contextBridge: ContextBridge }

contextBridge.executeInMainWorld({ func: installBrowserWindowCloseGuard })
