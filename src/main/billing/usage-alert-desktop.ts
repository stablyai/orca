// Electron side of the usage alert: the native notification, and its click opening
// Settings › Orca account (Plan & billing) in the main window.
import { app, Notification } from 'electron'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { getTrustedUIRendererWindow } from '../ipc/ui'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { translateMain } from '../i18n/main-i18n'
import { ORCA_PLAN_BILLING_SETTINGS_TARGET } from '../../shared/orca-billing'

export function usageAlertBody(percent: number): string {
  // Same key and copy as the in-app notice, so both read (and translate) alike.
  return translateMain(
    'auto.components.billing.teamUsedPercent',
    'Your team has used {{percent}}% of this month’s sandbox hours.',
    { percent: String(percent) }
  )
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
