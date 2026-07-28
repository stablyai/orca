import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Why: OS notification-permission state, separate from the delivery pipeline in
// mobile-notifications.ts. Nothing here touches sockets, watermarks, or the
// scheduled-push registry — it only reflects what the OS currently allows.

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
    // Why: Android <33 has no runtime notification permission, so "granted" is capability, not user consent.
    authorizationReflectsUserChoice:
      status === 'granted' && (Platform.OS !== 'android' || Number(Platform.Version) >= 33)
  }
}

// Why: re-read OS state every call — users can change it in Settings while Orca is backgrounded.
export async function ensureNotificationPermissions(): Promise<boolean> {
  const existing = await getNotificationPermissionState()
  if (existing.granted) {
    return true
  }

  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}
