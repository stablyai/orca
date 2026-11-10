import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Keep OS permission separate from socket delivery and push reconciliation.

export type NotificationPermissionState = {
  granted: boolean
  status: string
  canAskAgain: boolean
  authorizationReflectsUserChoice: boolean
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return {
    granted: status === 'granted',
    status,
    canAskAgain,
    // Android before 33 grants capability without runtime user consent.
    authorizationReflectsUserChoice:
      status === 'granted' && (Platform.OS !== 'android' || Number(Platform.Version) >= 33)
  }
}

// Reread every call because Settings can change permission while the app is backgrounded.
export async function ensureNotificationPermissions(): Promise<boolean> {
  const existing = await getNotificationPermissionState()
  if (existing.granted) {
    return true
  }

  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}
