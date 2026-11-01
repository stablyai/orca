import { app, Notification } from 'electron'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { buildNotificationOptions } from './notification-options'
import { getEffectiveNotificationSoundId } from './notification-sound-selection'
import { macosNotificationIdentity } from './macos-notification-center'
import {
  activeNotificationsById,
  logNativeNotificationFailure,
  retainNotificationUntilRelease,
  waitForNotificationDisplay
} from './native-notification-lifecycle'
import { recordNotificationDeliveryOutcome } from './notification-permission-probe'
import { forgetOpenableNotifications, registerOpenableNotification } from './openable-notifications'
import { getTrustedUIRendererWindow } from './ui'

export function deliverNativeNotification(
  args: NotificationDispatchRequest,
  notificationOptions: ReturnType<typeof buildNotificationOptions>,
  settings: NotificationSettings
): NotificationDispatchResult | Promise<NotificationDispatchResult> {
  if (getEffectiveNotificationSoundId(settings) !== 'system') {
    notificationOptions.silent = true
  }
  const notification = new Notification({
    ...notificationOptions,
    ...macosNotificationIdentity(args)
  })
  if (args.notificationId) {
    const previous = activeNotificationsById.get(args.notificationId)
    if (previous) {
      previous.notification.close()
      previous.release()
    }
    // A replacement without a reveal target registers no route, so retire the old one here.
    forgetOpenableNotifications([args.notificationId])
  }

  // Retain the notification and click handler through display lifetime.
  let clickHandler: (() => void) | null = null
  let failedHandler: ((_event: unknown, error?: string) => void) | null = null
  let unregisterOpenable: (() => void) | null = null
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
    // Release immediately on macOS delivery/signing failure instead of waiting for retention expiry.
    logNativeNotificationFailure(args.source, error)
    unregisterOpenable?.()
    // Feed permission-card fallback evidence.
    recordNotificationDeliveryOutcome('failed')
    release()
  }
  notification.on('failed', failedHandler)

  const worktreeId = args.worktreeId
  const paneTarget = args.paneKey ? parsePaneKey(args.paneKey) : null
  // Structured chat keys have synthetic leaves; reveal their unified tab instead of a nonexistent PTY pane.
  const chatTarget = args.surface === 'agent-session' ? paneTarget : null
  // Repo-less folder/floating workspaces still bind clicks through their pane target.
  const repoId = worktreeId?.includes('::') ? getRepoIdFromWorktreeId(worktreeId) : null
  if (worktreeId && (repoId !== null || paneTarget)) {
    const revealTarget = (): void => {
      const win = getTrustedUIRendererWindow()
      if (!win || win.isDestroyed()) {
        return
      }
      if (process.platform === 'darwin' && !isBackgroundLaunch()) {
        app.focus({ steal: true })
      }
      safelyRevealWindow(win)
      if (repoId !== null) {
        win.webContents.send('ui:activateWorktree', { repoId, worktreeId })
      }
      if (chatTarget) {
        win.webContents.send('ui:focusEditorTab', {
          tabId: chatTarget.tabId,
          worktreeId,
          userInitiated: true
        })
        return
      }
      if (!paneTarget) {
        return
      }
      // Stable leaf IDs select the exact split pane.
      win.webContents.send('ui:focusTerminal', {
        tabId: paneTarget.tabId,
        worktreeId,
        leafId: paneTarget.leafId,
        ackPaneKeyOnSuccess: args.paneKey,
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      })
    }
    clickHandler = () => {
      unregisterOpenable?.()
      release()
      revealTarget()
    }
    notification.on('click', clickHandler)
    // The open-latest shortcut acts as a click and also removes the banner from the OS list.
    unregisterOpenable = registerOpenableNotification(
      () => {
        notification.close()
        release()
        revealTarget()
      },
      { id: args.notificationId, paneKey: args.paneKey, origin: args.structuredOrigin }
    )
  }

  const displayConfirmation = args.requireDisplayConfirmation
    ? waitForNotificationDisplay(notification)
    : null
  notification.show()

  if (displayConfirmation) {
    return displayConfirmation.then((displayed) => {
      if (!displayed) {
        unregisterOpenable?.()
        release()
        return { delivered: false, reason: 'not-displayed' }
      }
      recordNotificationDeliveryOutcome('delivered')
      return { delivered: true }
    })
  }

  return { delivered: true }
}
