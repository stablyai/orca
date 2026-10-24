import { app } from 'electron'

let unreadCount = 0
let dockBadgeVisible = true

function applyDockBadge(): void {
  if (process.platform !== 'darwin') {
    return
  }

  // The toggle only gates the Dock write: the count keeps accumulating while hidden so re-enabling restores it.
  const label =
    !dockBadgeVisible || unreadCount === 0 ? '' : unreadCount > 99 ? '99+' : String(unreadCount)
  app.dock?.setBadge(label)
}

export function setUnreadDockBadgeCount(count: number): void {
  if (process.platform !== 'darwin') {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0

  applyDockBadge()
}

export function setDockBadgeVisible(visible: boolean): void {
  if (process.platform !== 'darwin') {
    return
  }

  if (dockBadgeVisible === visible) {
    return
  }

  dockBadgeVisible = visible
  applyDockBadge()
}
