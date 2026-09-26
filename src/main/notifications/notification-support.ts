import fs from 'node:fs'
import path from 'node:path'
import { Notification } from 'electron'

export type DesktopNotificationSupportOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isNotificationSupported?: () => boolean
  busSocketExists?: (busPath: string) => boolean
}

/**
 * Checks whether desktop notifications are supported and can actually be dispatched on the host OS.
 *
 * Why: Electron's `Notification.isSupported()` only checks if libnotify is dynamically loaded
 * on Linux, not whether a D-Bus session bus or desktop notification daemon is actually running.
 * On headless Linux hosts (such as systemd services running `orca serve`, containers, or Xvfb),
 * attempting to show a notification causes libnotify/Chromium to spam:
 *   "Failed to connect to the bus"
 *   "Failed to connect to proxy"
 *   "notify_notification_show: code=13 message='Unknown or unsupported transport'"
 * into the system journal on every agent event (#23220).
 */
export function isDesktopNotificationSupported(
  options: DesktopNotificationSupportOptions = {}
): boolean {
  const isSupported = options.isNotificationSupported ?? (() => Notification.isSupported())
  if (!isSupported()) {
    return false
  }

  const platform = options.platform ?? process.platform
  if (platform === 'linux') {
    const env = options.env ?? process.env
    if (!env.DBUS_SESSION_BUS_ADDRESS) {
      const runtimeDir = env.XDG_RUNTIME_DIR
      if (!runtimeDir) {
        return false
      }
      const busSocketExists = options.busSocketExists ?? fs.existsSync
      if (!busSocketExists(path.join(runtimeDir, 'bus'))) {
        return false
      }
    }
  }

  return true
}
