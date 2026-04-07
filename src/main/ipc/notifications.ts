import { app, BrowserWindow, Notification, ipcMain, systemPreferences, shell } from 'electron'
import type { Store } from '../persistence'
import type { NotificationDispatchRequest } from '../../shared/types'

const NOTIFICATION_COOLDOWN_MS = 5000

export type NotificationPermissionStatus = 'authorized' | 'denied' | 'not-determined' | 'unknown'

function getPermissionStatus(): NotificationPermissionStatus {
  if (process.platform !== 'darwin') {
    // Windows/Linux don't have a per-app notification permission gate.
    return Notification.isSupported() ? 'authorized' : 'denied'
  }
  // Why: getNotificationSettings() is macOS-only and absent from Electron's
  // cross-platform type definitions, so we need the cast.
  const getSettings = (systemPreferences as unknown as Record<string, unknown>)
    .getNotificationSettings as (() => { authorizationStatus: string }) | undefined
  if (!getSettings) {
    return 'unknown'
  }
  const settings = getSettings()
  switch (settings.authorizationStatus) {
    case 'authorized':
    case 'provisional':
      return 'authorized'
    case 'denied':
      return 'denied'
    case 'not determined':
      return 'not-determined'
    default:
      return 'unknown'
  }
}

export function registerNotificationHandlers(store: Store): void {
  const recentNotifications = new Map<string, number>()

  ipcMain.removeHandler('notifications:getPermissionStatus')
  ipcMain.handle('notifications:getPermissionStatus', (): NotificationPermissionStatus => {
    return getPermissionStatus()
  })

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
    (_event, args: NotificationDispatchRequest): { delivered: boolean } => {
      const settings = store.getSettings().notifications
      if (!settings.enabled || !Notification.isSupported()) {
        return { delivered: false }
      }

      if (
        (args.source === 'agent-task-complete' && !settings.agentTaskComplete) ||
        (args.source === 'terminal-bell' && !settings.terminalBell)
      ) {
        return { delivered: false }
      }

      const browserWindow =
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
      if (
        settings.suppressWhenFocused &&
        args.isActiveWorktree &&
        browserWindow &&
        browserWindow.isFocused()
      ) {
        return { delivered: false }
      }

      // Dedupe by worktree, not by source — an agent finishing and a terminal bell
      // often fire within the same data chunk so only the first one should surface.
      const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
      const now = Date.now()
      const lastSentAt = recentNotifications.get(dedupeKey) ?? 0
      if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
        return { delivered: false }
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

      // Why: clicking a notification should bring Orca to the foreground and
      // switch to the worktree that triggered it. We reuse the existing
      // ui:activateWorktree IPC channel that the renderer already handles
      // (setActiveRepo, setActiveView, setActiveWorktree, revealInSidebar).
      if (args.worktreeId) {
        const repoId = args.worktreeId.includes('::')
          ? args.worktreeId.slice(0, args.worktreeId.indexOf('::'))
          : ''
        notification.on('click', () => {
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
