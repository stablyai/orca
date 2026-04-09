import { app, BrowserWindow, Notification, ipcMain, shell } from 'electron'
import type { Store } from '../persistence'
import type { NotificationDispatchRequest, NotificationDispatchResult } from '../../shared/types'

const NOTIFICATION_COOLDOWN_MS = 5000

// Why: Electron Notification objects are normal JS objects — if the only
// reference is a local variable inside the ipcMain handler, the GC can
// collect them (and their click handlers) before the user interacts with
// the notification in macOS Notification Center. Prevent this by keeping a
// strong reference until the notification is clicked or closed.
const activeNotifications = new Set<Notification>()

export function registerNotificationHandlers(store: Store): void {
  const recentNotifications = new Map<string, number>()

  ipcMain.removeHandler('notifications:openSystemSettings')
  ipcMain.handle('notifications:openSystemSettings', (): void => {
    if (process.platform === 'darwin') {
      // Deep-link into the macOS Notifications settings pane.
      void shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings')
    } else if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:notifications')
    }
  })

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (_event, args: NotificationDispatchRequest): NotificationDispatchResult => {
      if (!Notification.isSupported()) {
        return { delivered: false, reason: 'not-supported' }
      }

      const settings = store.getSettings().notifications
      if (!settings.enabled) {
        return { delivered: false, reason: 'disabled' }
      }

      if (
        (args.source === 'agent-task-complete' && !settings.agentTaskComplete) ||
        (args.source === 'terminal-bell' && !settings.terminalBell)
      ) {
        return { delivered: false, reason: 'source-disabled' }
      }

      const browserWindow =
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
      if (
        settings.suppressWhenFocused &&
        args.isActiveWorktree &&
        browserWindow &&
        browserWindow.isFocused()
      ) {
        return { delivered: false, reason: 'suppressed-focus' }
      }

      // Dedupe by worktree, not by source — an agent finishing and a terminal bell
      // often fire within the same data chunk so only the first one should surface.
      const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
      const now = Date.now()
      const lastSentAt = recentNotifications.get(dedupeKey) ?? 0
      if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
        return { delivered: false, reason: 'cooldown' }
      }
      recentNotifications.set(dedupeKey, now)

      // Evict stale entries so the map doesn't grow unbounded.
      if (recentNotifications.size > 50) {
        for (const [key, ts] of recentNotifications) {
          if (now - ts >= NOTIFICATION_COOLDOWN_MS) {
            recentNotifications.delete(key)
          }
        }
      }

      const notification = new Notification(buildNotificationOptions(args))

      // Why: prevent GC from collecting the notification (and its click
      // handler) while it's still visible in macOS Notification Center.
      activeNotifications.add(notification)
      const release = (): void => {
        activeNotifications.delete(notification)
      }
      notification.on('close', release)
      // Why: on macOS the 'close' event may never fire if the OS silently
      // discards the notification (e.g. DND, Notification Center cleared).
      // A timeout fallback guarantees the reference is eventually freed.
      setTimeout(release, 5 * 60 * 1000)

      // Why: clicking a notification should bring Orca to the foreground and
      // switch to the worktree that triggered it. We reuse the existing
      // ui:activateWorktree IPC channel that the renderer already handles
      // (setActiveRepo, setActiveView, setActiveWorktree, revealInSidebar).
      // Why: worktreeId is formatted as "repoId::worktreePath".  If the
      // separator is missing we cannot reliably extract a repoId, so skip
      // the click-to-navigate binding — the notification still fires but
      // clicking it will not attempt to switch to an unknown worktree.
      if (args.worktreeId && args.worktreeId.includes('::')) {
        const repoId = args.worktreeId.slice(0, args.worktreeId.indexOf('::'))
        notification.on('click', () => {
          release()
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
          if (!win) {
            return
          }
          if (process.platform === 'darwin') {
            app.focus({ steal: true })
          }
          if (win.isMinimized()) {
            win.restore()
          }
          win.focus()
          win.webContents.send('ui:activateWorktree', {
            repoId,
            worktreeId: args.worktreeId
          })
        })
      }

      notification.show()
      return { delivered: true }
    }
  )
}

/**
 * On first launch, when macOS notification permission is 'not-determined',
 * show a welcome notification to trigger the system permission dialog.
 *
 * Why: macOS requires at least one notification attempt before the system
 * will prompt the user to allow/deny. Doing this at startup with meaningful
 * content avoids a confusing blank notification later. The notification is
 * closed shortly after to avoid lingering in Notification Center.
 */
export function triggerStartupNotificationRegistration(store: Store): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) {
    return
  }
  // Why: only fire once per install — not on every launch where status stays
  // not-determined (e.g. if the user dismisses the macOS dialog without choosing).
  const ui = store.getUI()
  if (ui.notificationPermissionRequested) {
    return
  }
  store.updateUI({ notificationPermissionRequested: true })

  const notification = new Notification({
    title: 'Orca is ready to notify you',
    body: 'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
  })

  let handled = false
  const cleanup = (): void => {
    if (handled) {
      return
    }
    handled = true
    notification.close()
  }

  notification.on('show', () => {
    // Why: close after a short delay so the notification doesn't linger in
    // Notification Center. The macOS permission dialog is a system-level sheet
    // that appears independently and is not dismissed by closing this notification.
    setTimeout(cleanup, 8000)
  })

  // Fallback in case macOS doesn't fire the 'show' event (e.g. user denies).
  setTimeout(cleanup, 10_000)

  notification.show()
}

function buildNotificationOptions(args: NotificationDispatchRequest): {
  title: string
  body: string
  silent?: boolean
} {
  if (args.source === 'terminal-bell') {
    return {
      title: `Bell in ${args.worktreeLabel ?? 'workspace'}`,
      body: args.repoLabel ? `${args.repoLabel} · Attention requested` : 'Attention requested'
    }
  }

  if (args.source === 'test') {
    return {
      title: 'Orca notifications are on',
      body: 'This is a test notification from Orca.'
    }
  }

  return {
    title: `Task complete in ${args.worktreeLabel ?? 'workspace'}`,
    body: args.repoLabel
      ? `${args.repoLabel}${args.terminalTitle ? ` · ${args.terminalTitle}` : ''}`
      : (args.terminalTitle ?? 'A coding agent finished working.')
  }
}
