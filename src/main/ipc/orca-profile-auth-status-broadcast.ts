import { BrowserWindow } from 'electron'
import { ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL } from '../../shared/orca-profiles'

export function broadcastOrcaProfileAuthStatusChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
