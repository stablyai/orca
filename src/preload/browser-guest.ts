import { installBrowserGuestMainWorld } from './browser-guest-main-world-installation'
import type { ContextBridge } from 'electron'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
const { contextBridge } = require('electron') as { contextBridge: ContextBridge }

installBrowserGuestMainWorld(contextBridge)
