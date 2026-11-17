import { app } from 'electron'

let unreadCount = 0
let agentNeedsInput = false

function applyDockBadge(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const countLabel = unreadCount === 0 ? '' : unreadCount > 99 ? '99+' : String(unreadCount)
  // Dock badges are text-only, so a leading "!" marks an agent waiting on the user.
  app.dock?.setBadge(agentNeedsInput ? `!${countLabel}` : countLabel)
}

export function setUnreadDockBadgeCount(count: number, needsInput = false): void {
  if (process.platform !== 'darwin') {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  agentNeedsInput = needsInput

  applyDockBadge()
}
