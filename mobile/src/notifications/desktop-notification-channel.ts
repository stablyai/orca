import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Why an id both sides share: the gateway's FCM payload names this channel, so a
// background push can be the first thing that ever targets it. Android drops a
// notification whose channel does not exist, and the channel used to be created
// only inside subscribeToDesktopNotifications — i.e. only once a socket connected.
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'

/** Idempotent on Android (the OS updates the existing channel); a no-op elsewhere. */
export async function ensureDesktopNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  await Notifications.setNotificationChannelAsync(`${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`, {
    name: 'Orca silent notifications',
    importance: Notifications.AndroidImportance.HIGH,
    sound: null,
    enableVibrate: false
  })
  await Notifications.setNotificationChannelAsync(DESKTOP_NOTIFICATION_CHANNEL_ID, {
    name: 'Desktop Notifications',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250],
    lightColor: '#6366f1'
  })
}
