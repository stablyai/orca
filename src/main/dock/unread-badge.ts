import { app } from 'electron'

export function setUnreadDockBadgeCount(count: number): void {
  if (process.platform !== 'darwin') {
    return
  }

  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  const label = normalizedCount === 0 ? '' : normalizedCount > 99 ? '99+' : String(normalizedCount)

  // Why: unread counts belong on the native Dock tile on macOS.
  // Windows/Linux are skipped until we define the right platform behavior.
  app.dock?.setBadge(label)
}
