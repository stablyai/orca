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
  const deadline = performance.now() + timeoutMs
  const probes = [
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
    },
    {
      // gdbus introspects first. Prefer the direct call on daemons that omit introspection.
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
    }
  ]
  let missing = true
  for (const probe of probes) {
    const remainingMs = deadline - performance.now()
    if (remainingMs < 1) {
      return false
    }
    try {
      const result = await runProcess({ ...probe, timeoutMs: remainingMs, maxOutputBytes: 4_096 })
      return result.code === 0 && !result.timedOut && performance.now() < deadline
    } catch (error) {
      // Process host rejects spawn errors and returns D-Bus errors as exit results.
      missing &&= error instanceof Error && 'code' in error && error.code === 'ENOENT'
    }
  }
  // Portable installs can deliver through libnotify even when neither CLI is installed.
  return missing && performance.now() < deadline
}

function checkLinuxNotificationService(): Promise<boolean> {
  serviceCheck ??= probeLinuxNotificationService().finally(() => {
    serviceCheck = undefined
  })
  return serviceCheck
}

/** Whether the notification was submitted to the system; Linux answers after its service check. */
export function showDesktopNotification(
  notification: Notification,
  beforeShow?: () => void
): boolean | Promise<boolean> {
  if (process.platform !== 'linux') {
    beforeShow?.()
    notification.show()
    return true
  }

  // Electron's libnotify calls block while D-Bus waits for a pending activation.
  pendingShows.add(notification)
  return checkLinuxNotificationService().then((ready) => {
    if (!pendingShows.delete(notification)) {
      return false
    }
    if (!ready) {
      notification.emit('failed', undefined, 'Linux notification service did not respond')
      return false
    }
    // Why: a daemon that rejects Notify makes Electron emit `failed` from inside show().
    let rejected = false
    const markRejected = (): void => {
      rejected = true
    }
    notification.once('failed', markRejected)
    try {
      beforeShow?.()
      notification.show()
      return !rejected
    } catch (error) {
      notification.emit('failed', undefined, String(error))
      return false
    } finally {
      notification.removeListener('failed', markRejected)
    }
  })
}

export function cancelPendingDesktopNotification(notification: Notification): boolean {
  return pendingShows.delete(notification)
}

export function closeDesktopNotification(notification: Notification): void {
  if (cancelPendingDesktopNotification(notification)) {
    notification.emit('close', { reason: 'applicationHidden' })
    return
  }
  notification.close()
}
