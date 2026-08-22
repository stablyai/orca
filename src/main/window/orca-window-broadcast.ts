import type { BrowserWindow } from 'electron'
import { orcaWindowManager } from './orca-window-manager'

export function broadcastToOrcaWindows(
  fallback: () => BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): void {
  const windows = orcaWindowManager.getAllWindows()
  const legacyWindow = windows.length === 0 ? fallback() : null
  if (legacyWindow && !legacyWindow.isDestroyed()) {
    windows.push(legacyWindow)
  }
  for (const window of windows) {
    if (!window.isDestroyed() && window.webContents.isDestroyed?.() !== true) {
      try {
        window.webContents.send(channel, ...args)
      } catch {
        // One unavailable renderer must not block sibling windows.
      }
    }
  }
}
