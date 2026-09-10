import { readNativeNotificationData } from './native-notification-data'
import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import { rememberPushDismissal, wasPushDismissed } from './push-dismissal-watermarks'

async function dismissMatchingPresentedPushes(
  matches: (payload: OrcaPushPayload) => boolean | Promise<boolean>
): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync()
  await Promise.all(
    presented.map(async (notification) => {
      const payload = readOrcaPushPayload(readNativeNotificationData(notification.request))
      if (payload && (await matches(payload))) {
        await Notifications.dismissNotificationAsync(notification.request.identifier)
      }
    })
  )
}

export function dismissRememberedPushNotifications(
  hostFingerprint: string,
  confirmed: readonly OrcaPushPayload[]
): Promise<void> {
  return dismissMatchingPresentedPushes(async (payload) => {
    if (payload.hostFingerprint !== hostFingerprint) {
      return false
    }
    return (
      confirmed.some(
        (fence) =>
          fence.notificationId === payload.notificationId &&
          fence.notificationEpoch === payload.notificationEpoch &&
          fence.notificationSeq !== undefined &&
          payload.notificationSeq !== undefined &&
          fence.notificationSeq >= payload.notificationSeq
      ) || wasPushDismissed(payload)
    )
  })
}

// Pushes shown while Orca was closed are absent from the local scheduling registry.
export async function dismissPresentedPushNotification(
  notificationId: string,
  hostFingerprint: string,
  fence?: { notificationEpoch?: string; notificationSeq?: number }
): Promise<void> {
  if (fence) {
    await rememberPushDismissal({ hostFingerprint, notificationId, ...fence })
  }
  await dismissMatchingPresentedPushes((payload) => {
    if (payload.hostFingerprint !== hostFingerprint) {
      return false
    }
    return (
      payload.notificationId === notificationId &&
      (!fence ||
        Boolean(
          fence.notificationEpoch &&
          fence.notificationSeq !== undefined &&
          payload.notificationEpoch === fence.notificationEpoch &&
          payload.notificationSeq !== undefined &&
          payload.notificationSeq <= fence.notificationSeq
        ))
    )
  })
}
