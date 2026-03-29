import { BrowserWindow, Notification, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { NotificationDispatchRequest } from '../../shared/types'

const NOTIFICATION_COOLDOWN_MS = 5000

export function registerNotificationHandlers(store: Store): void {
  const recentNotifications = new Map<string, number>()

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

      const dedupeKey = `${args.source}:${args.worktreeId ?? args.worktreeLabel ?? 'global'}`
      const now = Date.now()
      const lastSentAt = recentNotifications.get(dedupeKey) ?? 0
      if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
        return { delivered: false }
      }
      recentNotifications.set(dedupeKey, now)

      const notification = new Notification(buildNotificationOptions(args))
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
