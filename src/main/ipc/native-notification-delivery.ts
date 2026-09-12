import { app, Notification } from 'electron'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { buildNotificationOptions } from './notification-options'
import { getEffectiveNotificationSoundId } from './notification-sound-selection'
import {
  activeNotificationsById,
  logNativeNotificationFailure,
  retainNotificationUntilRelease,
  waitForNotificationDisplay
} from './native-notification-lifecycle'
import { recordNotificationDeliveryOutcome } from './notification-permission-probe'
import { getTrustedUIRendererWindow } from './ui'

export function deliverNativeNotification(
  args: NotificationDispatchRequest,
  notificationOptions: ReturnType<typeof buildNotificationOptions>,
  settings: NotificationSettings
): NotificationDispatchResult | Promise<NotificationDispatchResult> {
  if (getEffectiveNotificationSoundId(settings) !== 'system') {
    notificationOptions.silent = true
  } else if (process.platform === 'darwin') {
    // Why: macOS treats an unset sound as silent, so request Electron's default when using the OS sound.
    notificationOptions.sound = 'default'
  }
  const notification = new Notification(notificationOptions)
  if (args.notificationId) {
    const previous = activeNotificationsById.get(args.notificationId)
    if (previous) {
      previous.notification.close()
      previous.release()
    }
  }

  // Why: prevent GC from collecting the notification and its click handler while it's still visible.
  let clickHandler: (() => void) | null = null
  let failedHandler: ((_event: unknown, error?: string) => void) | null = null
  const entryForId: { notification: Notification; release: () => void } | null = args.notificationId
    ? { notification, release: () => {} }
    : null
  const release = retainNotificationUntilRelease(notification, () => {
    if (clickHandler) {
      notification.removeListener('click', clickHandler)
      clickHandler = null
    }
    if (failedHandler) {
      notification.removeListener('failed', failedHandler)
      failedHandler = null
    }
    if (args.notificationId && activeNotificationsById.get(args.notificationId) === entryForId) {
      activeNotificationsById.delete(args.notificationId)
    }
  })
  if (entryForId && args.notificationId) {
    entryForId.release = release
    activeNotificationsById.set(args.notificationId, entryForId)
  }

  failedHandler = (_event, error) => {
    // Why: Electron 42's macOS backend reports unsigned/delivery failures here; release now, not after the fallback timer.
    logNativeNotificationFailure(args.source, error)
    // Why: feeds the permission card's evidence.
    recordNotificationDeliveryOutcome('failed')
    release()
  }
  notification.on('failed', failedHandler)

  if (args.worktreeId) {
    // Why: worktreeId is formatted "repoId::worktreePath"; folder workspaces carry no repo, so activate by workspace id alone.
    const repoId = args.worktreeId.includes('::')
      ? getRepoIdFromWorktreeId(args.worktreeId)
      : undefined
    clickHandler = () => {
      release()
      const win = getTrustedUIRendererWindow()
      if (!win || win.isDestroyed()) {
        return
      }
      if (process.platform === 'darwin' && !isBackgroundLaunch()) {
        app.focus({ steal: true })
      }
      safelyRevealWindow(win)
      // Why: one ordered intent — activation may load asynchronously, so the renderer focuses the pane itself once the workspace resolves.
      win.webContents.send('ui:activateWorktree', {
        ...(repoId ? { repoId } : {}),
        worktreeId: args.worktreeId,
        notificationPaneKey: args.paneKey ?? null,
        ...(args.executionHostId ? { executionHostId: args.executionHostId } : {})
      })
    }
    notification.on('click', clickHandler)
  }

  const displayConfirmation = args.requireDisplayConfirmation
    ? waitForNotificationDisplay(notification)
    : null
  notification.show()

  if (displayConfirmation) {
    return displayConfirmation.then((displayed) => {
      if (!displayed) {
        release()
        return { delivered: false, reason: 'not-displayed' }
      }
      recordNotificationDeliveryOutcome('delivered')
      return { delivered: true }
    })
  }

  return { delivered: true }
}
