export type PushNotificationIdentity = {
  notificationId: string
  notificationEpoch: string
  notificationSeq: number
}

export function readPushNotificationIdentity(value: unknown): PushNotificationIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as PushNotificationIdentity
  return typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    item.notificationId.length <= 2048 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    item.notificationEpoch.length <= 128 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0
    ? {
        notificationId: item.notificationId,
        notificationEpoch: item.notificationEpoch,
        notificationSeq: item.notificationSeq
      }
    : null
}
