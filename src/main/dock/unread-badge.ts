import { app } from 'electron'

let idleDockBadgeLabel = ''
let unreadCount = 0

function applyDockBadge(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const label =
    unreadCount === 0 ? idleDockBadgeLabel : unreadCount > 99 ? '99+' : String(unreadCount)

  app.dock?.setBadge(label)
}

export function setIdleDockBadgeLabel(label: string | null | undefined): void {
  idleDockBadgeLabel = label ?? ''
  applyDockBadge()
}

export function setUnreadDockBadgeCount(count: number): void {
  if (process.platform !== 'darwin') {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0

  // Why: unread counts own the native badge while active; otherwise dev builds
  // keep their worktree badge visible so parallel `pn dev` windows stay distinct.
  applyDockBadge()
}
