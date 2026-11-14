import type { PushNotification } from '@orca-cloud/push-contract/send-messages'

export function parsePushDeliveryPayload(payload: string): PushNotification {
  const value: unknown = JSON.parse(payload)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_push_delivery_payload')
  return value as PushNotification
}
