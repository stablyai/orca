import type { ContextBridge } from 'electron'
import { installBrowserAntiDetection } from './browser-anti-detection-installation'
import { installBrowserWindowCloseGuard } from './browser-window-close-installation'

export function installBrowserGuestMainWorld(contextBridge: ContextBridge): void {
  for (const func of [installBrowserWindowCloseGuard, installBrowserAntiDetection]) {
    try {
      contextBridge.executeInMainWorld({ func })
    } catch {
      // Best-effort: one main-world patch must not block the other or escape the preload.
    }
  }
}
