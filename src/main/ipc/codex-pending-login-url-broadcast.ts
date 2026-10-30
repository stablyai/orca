import { BrowserWindow } from 'electron'
import { CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL } from '../../shared/codex-auth-errors'

export function broadcastCodexPendingLoginUrl(url: string | null): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(CODEX_PENDING_LOGIN_URL_CHANGED_CHANNEL, url)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
