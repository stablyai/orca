import { Notification, shell } from 'electron'

const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

const activePermissionNotifications = new Set<Notification>()

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

  let releaseTimer: ReturnType<typeof setTimeout> | null = null
  let released = false
  function release(): void {
    if (released) {
      return
    }
    released = true
    activePermissionNotifications.delete(notification)
    notification.removeListener('close', release)
    notification.removeListener('click', onClick)
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
  }
  function onClick(): void {
    release()
    if (process.platform === 'darwin') {
      void shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
    }
  }
  notification.on('close', release)
  notification.on('click', onClick)
  releaseTimer = setTimeout(release, 5 * 60 * 1000)
  if (typeof releaseTimer.unref === 'function') {
    releaseTimer.unref()
  }
  notification.show()
}
