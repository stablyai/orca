import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload } from './push-payload'

/**
 * Retire a push the OS presented for a notification the desktop has now dismissed.
 * The local scheduling registry knows nothing about it — the OS drew it while Orca
 * was closed — so the notification tray is the only place it can be found.
 *
 * Kept out of push-receive.ts deliberately: this runs on the socket dismiss path,
 * which must not pull the host store (and its native keychain deps) behind it.
 */
export async function dismissPresentedPushNotification(notificationId: string): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      presented.map(async (notification) => {
        const payload = readOrcaPushPayload(notification.request.content.data)
        if (payload?.notificationId !== notificationId) {
          return
        }
        await Notifications.dismissNotificationAsync(notification.request.identifier).catch(
          () => {}
        )
      })
    )
  } catch {
    // Older native shells lack the tray query; local dismissal still runs.
  }
}
