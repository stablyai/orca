import { app } from 'electron'

let unreadCount = 0

function applyDockBadge(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const label = unreadCount === 0 ? '' : unreadCount > 99 ? '99+' : String(unreadCount)
  app.dock?.setBadge(label)
}

export function setUnreadDockBadgeCount(count: number): void {
  if (process.platform !== 'darwin') {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0

  applyDockBadge()
}
