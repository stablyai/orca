import fs from 'node:fs'
import path from 'node:path'
import { Notification } from 'electron'

export type DesktopNotificationSupportOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isNotificationSupported?: () => boolean
  busSocketExists?: (busPath: string) => boolean
  canonicalRuntimeDir?: string | null
}

const CANONICAL_USER_RUNTIME_DIR =
  typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null

function hasReachableBusSocket(
  dir: string,
  busSocketExists?: (busPath: string) => boolean
): boolean {
  // Use posix join for Linux runtime paths so tests/runs on Windows resolve canonical forward slashes
  const busPath = path.posix.join(dir, 'bus')
  if (busSocketExists) {
    return busSocketExists(busPath)
  }
  try {
    return fs.statSync(busPath).isSocket()
  } catch {
    return false
  }
}

function isUsableDbusAddress(address?: string): boolean {
  if (!address) {
    return false
  }
  const trimmed = address.trim()
  // Chromium's content_main injects "disabled:" when DBUS_SESSION_BUS_ADDRESS is unset on headless Linux.
  // GLib/libnotify cannot connect to "disabled:" or "autolaunch:" and spams transport errors.
  if (!trimmed || trimmed === 'disabled:' || trimmed === 'autolaunch:') {
    return false
  }
  return trimmed.includes(':')
}

/**
 * Checks whether desktop notifications are supported and can actually be dispatched on the host OS.
 *
 * Why: Electron's `Notification.isSupported()` only checks if libnotify is dynamically loaded
 * on Linux, not whether a D-Bus session bus or desktop notification daemon is actually running.
 * On headless Linux hosts (such as systemd services running `orca serve`, containers, or Xvfb),
 * Chromium injects `DBUS_SESSION_BUS_ADDRESS=disabled:` and attempting to show a notification causes
 * libnotify/Chromium to spam:
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
    const dbusAddress = env.DBUS_SESSION_BUS_ADDRESS

    if (isUsableDbusAddress(dbusAddress)) {
      return true
    }

    const canonicalDir =
      options.canonicalRuntimeDir !== undefined
        ? options.canonicalRuntimeDir
        : CANONICAL_USER_RUNTIME_DIR

    if (canonicalDir && hasReachableBusSocket(canonicalDir, options.busSocketExists)) {
      return true
    }

    if (env.XDG_RUNTIME_DIR && hasReachableBusSocket(env.XDG_RUNTIME_DIR, options.busSocketExists)) {
      return true
    }

    return false
  }

  return true
}
