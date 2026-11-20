import { runProcess } from '@orca/process-host'
import type { Notification } from 'electron'

const pendingShows = new WeakSet<Notification>()
let serviceCheck: Promise<boolean> | undefined

function checkLinuxNotificationService(): Promise<boolean> {
  // A real call preserves D-Bus auto-activation, including daemons that start on first use.
  serviceCheck ??= runProcess({
    program: 'gdbus',
    args: [
      'call',
      '--session',
      '--timeout',
      '2',
      '--dest',
      'org.freedesktop.Notifications',
      '--object-path',
      '/org/freedesktop/Notifications',
      '--method',
      'org.freedesktop.Notifications.GetCapabilities'
    ],
    timeoutMs: 2_000,
    maxOutputBytes: 4_096
  })
    .then(
      (result) => result.code === 0 && !result.timedOut,
      () => false
    )
    .finally(() => {
      serviceCheck = undefined
    })
  return serviceCheck
}

export function showDesktopNotification(notification: Notification): void {
  if (process.platform !== 'linux') {
    notification.show()
    return
  }

  // Electron's libnotify calls block while D-Bus waits for a pending activation.
  pendingShows.add(notification)
  void checkLinuxNotificationService().then((ready) => {
    if (!pendingShows.delete(notification)) {
      return
    }
    if (!ready) {
      notification.emit('failed', undefined, 'Linux notification service did not respond')
      return
    }
    try {
      notification.show()
    } catch (error) {
      notification.emit('failed', undefined, String(error))
    }
  })
}

export function closeDesktopNotification(notification: Notification): void {
  if (process.platform === 'linux' && pendingShows.delete(notification)) {
    notification.emit('close', { reason: 'applicationHidden' })
    return
  }
  notification.close()
}
