import type * as Notifications from 'expo-notifications'
import { sha256 } from '../../../../src/shared/hashing/sha256'
import { readOrcaPushPayload } from '../payload-identity/push-payload'
import { readNativeNotificationData } from '../payload-identity/native-notification-data'

export function notificationReplyResponseId(response: Notifications.NotificationResponse): string {
  const text =
    'userText' in response && typeof response.userText === 'string' ? response.userText : ''
  const payload = readOrcaPushPayload(readNativeNotificationData(response.notification.request))
  return Array.from(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          payload?.hostFingerprint,
          payload?.notificationEpoch,
          payload?.notificationSeq,
          response.notification.request.identifier,
          text
        ])
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}
