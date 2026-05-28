import { Notification, shell, systemPreferences } from 'electron'

const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const DEFAULT_ACCESSIBILITY_INSTRUCTIONS =
  'System Settings -> Privacy & Security -> Accessibility -> enable Orca'

const activePermissionNotifications = new Set<Notification>()

/** Probe accessibility permissions; lazy -- invoked only on first failure path. */
export async function checkAccessibilityPermission(): Promise<{
  ok: boolean
  instructions?: string
}> {
  if (process.platform !== 'darwin') {
    return { ok: true }
  }

  try {
    const ok = systemPreferences.isTrustedAccessibilityClient(false)
    return ok ? { ok: true } : { ok: false, instructions: DEFAULT_ACCESSIBILITY_INSTRUCTIONS }
  } catch {
    return { ok: false, instructions: DEFAULT_ACCESSIBILITY_INSTRUCTIONS }
  }
}

/** Surface a notification through Orca's existing notification system (do not duplicate UI). */
export function notifyPermissionRequired(instructions: string): void {
  if (!Notification.isSupported()) {
    return
  }

  const notification = new Notification({
    title: 'Accessibility permission required',
    body: instructions
  })
  activePermissionNotifications.add(notification)

  const release = (): void => {
    activePermissionNotifications.delete(notification)
  }
  notification.on('close', release)
  notification.on('click', () => {
    release()
    if (process.platform === 'darwin') {
      void shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
    }
  })
  setTimeout(release, 5 * 60 * 1000)
  notification.show()
}
