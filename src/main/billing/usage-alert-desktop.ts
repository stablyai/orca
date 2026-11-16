// Electron side of the usage alert: the native notification. Its click hands the main window the
// billing target, which opens the web console's billing page for an owner or admin and Settings ›
// Orca account for a member (settings-sidebar-ipc-bridge).
import { app, Notification } from 'electron'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { getTrustedUIRendererWindow } from '../ipc/ui'
import { safelyRevealWindow } from '../window/activation/focus-existing-window'
import { isBackgroundLaunch } from '../window/activation/foreground-activation-policy'
import { mainI18n, translateMain } from '../i18n/main-i18n'
import { usageAlertSentence } from '../../shared/orca-billing-usage-alerts'
import {
  ORCA_PLAN_BILLING_SETTINGS_TARGET,
  type OrcaBillingEntitlement
} from '../../shared/orca-billing'

export function usageAlertBody(entitlement: OrcaBillingEntitlement): string | null {
  // Same sentence and keys as the in-app notice, so both read (and translate) alike.
  return usageAlertSentence(entitlement, translateMain, mainI18n.language || 'en')
}

export function showUsageAlertNotification({ title, body }: { title: string; body: string }): void {
  if (!Notification.isSupported()) {
    return
  }
  const notification = new Notification({ title, body })
  const onClick = (): void => {
    release()
    const win = getTrustedUIRendererWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    if (process.platform === 'darwin' && !isBackgroundLaunch()) {
      app.focus({ steal: true })
    }
    safelyRevealWindow(win)
    win.webContents.send('ui:openSettings', ORCA_PLAN_BILLING_SETTINGS_TARGET)
  }
  // Keep the notification (and its click handler) alive until it closes.
  const release = retainNotificationUntilRelease(notification, () => {
    notification.removeListener('click', onClick)
  })
  notification.on('click', onClick)
  notification.show()
}
