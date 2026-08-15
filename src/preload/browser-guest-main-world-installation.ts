import type { ContextBridge } from 'electron'
import { installBrowserAntiDetection } from './browser-anti-detection-installation'
import { installBrowserWindowCloseGuard } from './browser-window-close-installation'

export function installBrowserGuestMainWorld(contextBridge: ContextBridge): void {
  contextBridge.executeInMainWorld({ func: installBrowserWindowCloseGuard })
  contextBridge.executeInMainWorld({ func: installBrowserAntiDetection })
}
