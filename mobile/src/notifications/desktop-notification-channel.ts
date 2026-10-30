import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { translate } from '../i18n/mobile-i18n'

// Create the shared FCM channel before socket subscription: a background push can arrive first, and Android drops notifications for missing channels.
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'

// Android updates existing channels, so calling again after a language change renames them; other platforms do nothing.
export async function ensureDesktopNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  await Notifications.setNotificationChannelAsync(`${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`, {
    name: translate('notifications.desktopChannel.silentName', 'Orca silent notifications'),
    importance: Notifications.AndroidImportance.HIGH,
    sound: null,
    enableVibrate: false
  })
  await Notifications.setNotificationChannelAsync(DESKTOP_NOTIFICATION_CHANNEL_ID, {
    name: translate('notifications.desktopChannel.name', 'Desktop Notifications'),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250],
    lightColor: '#6366f1'
  })
}
