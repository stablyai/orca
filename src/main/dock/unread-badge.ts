import { app } from 'electron'
import { createDefaultLinuxLauncherBadge, type LinuxLauncherBadge } from './linux-launcher-badge'

let unreadCount = 0
let linuxLauncherBadge: LinuxLauncherBadge | null = null

function supportsDockBadge(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

function applyDockBadge(): void {
  if (process.platform === 'darwin') {
    const label = unreadCount === 0 ? '' : unreadCount > 99 ? '99+' : String(unreadCount)
    app.dock?.setBadge(label)
    return
  }
  if (process.platform === 'linux') {
    linuxLauncherBadge ??= createDefaultLinuxLauncherBadge()
    linuxLauncherBadge.setCount(unreadCount)
  }
}

export function setUnreadDockBadgeCount(count: number): void {
  if (!supportsDockBadge()) {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0

  applyDockBadge()
}

/** Quit path: lets the Linux helper hide the badge and exit instead of being orphaned. */
export function disposeUnreadDockBadge(): void {
  linuxLauncherBadge?.dispose()
  linuxLauncherBadge = null
}
