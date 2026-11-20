import { runProcess } from '@orca/process-host'
import type { Notification } from 'electron'

const pendingShows = new WeakSet<Notification>()
let serviceCheck: Promise<boolean> | undefined

async function probeLinuxNotificationService(): Promise<boolean> {
  // A real call preserves D-Bus auto-activation, including daemons that start on first use.
  const name = 'org.freedesktop.Notifications'
  const objectPath = '/org/freedesktop/Notifications'
  const method = `${name}.GetCapabilities`
  const timeoutMs = 2_000
  const probes = [
    {
      program: 'gdbus',
      args: [
        'call',
        '--session',
        '--timeout',
        String(timeoutMs / 1_000),
        '--dest',
        name,
        '--object-path',
        objectPath,
        '--method',
        method
      ]
    },
    {
      program: 'dbus-send',
      args: [
        '--session',
        '--print-reply',
        `--reply-timeout=${timeoutMs}`,
        `--dest=${name}`,
        objectPath,
        method
      ]
    }
  ]
  for (const probe of probes) {
    try {
      const result = await runProcess({ ...probe, timeoutMs, maxOutputBytes: 4_096 })
      return result.code === 0 && !result.timedOut
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        return false
      }
    }
  }
  // Portable installs can deliver through libnotify even when neither CLI is installed.
  return true
}

function checkLinuxNotificationService(): Promise<boolean> {
  serviceCheck ??= probeLinuxNotificationService().finally(() => {
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
