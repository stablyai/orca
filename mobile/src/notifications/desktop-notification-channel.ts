import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Why an id both sides share: the gateway's FCM payload names this channel, so a
// background push can be the first thing that ever targets it. Android drops a
// notification whose channel does not exist, and the channel used to be created
// only inside subscribeToDesktopNotifications — i.e. only once a socket connected.
export const DESKTOP_NOTIFICATION_CHANNEL_ID = 'orca-desktop'
export const DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID = 'orca-desktop-urgent'
export const DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID = 'orca-desktop-complete'

// Triple-pulse staccato pattern for urgent attention (needs input / terminal bell)
// vs. crisp double-pulse pattern for task completion, so tactile feel alone
// distinguishes Orca from single-buzz messaging apps.
export const URGENT_VIBRATION_PATTERN = [0, 180, 90, 180, 90, 320]
export const COMPLETE_VIBRATION_PATTERN = [0, 120, 80, 260]

/** Idempotent on Android (the OS updates the existing channel); a no-op elsewhere. */
export async function ensureDesktopNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  const maxImportance = Notifications.AndroidImportance.MAX ?? Notifications.AndroidImportance.HIGH
  await Notifications.setNotificationChannelAsync(`${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`, {
    name: 'Orca silent notifications',
    importance: Notifications.AndroidImportance.HIGH,
    sound: null,
    enableVibrate: false
  })
  await Notifications.setNotificationChannelAsync(DESKTOP_NOTIFICATION_CHANNEL_ID, {
    name: 'Desktop Notifications',
    importance: maxImportance,
    vibrationPattern: COMPLETE_VIBRATION_PATTERN,
    lightColor: '#6366f1'
  })
  await Notifications.setNotificationChannelAsync(DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID, {
    name: 'Orca Urgent (Needs Input)',
    importance: maxImportance,
    vibrationPattern: URGENT_VIBRATION_PATTERN,
    lightColor: '#f59e0b'
  })
  await Notifications.setNotificationChannelAsync(DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID, {
    name: 'Orca Task Complete',
    importance: maxImportance,
    vibrationPattern: COMPLETE_VIBRATION_PATTERN,
    lightColor: '#10b981'
  })
}
