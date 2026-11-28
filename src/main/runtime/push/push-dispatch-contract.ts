import type { MobilePushRegistration } from '../../../shared/notifications/mobile-push-contract'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import type { PushGatewayClient } from './push-gateway-client'
import type { MobilePushDeliveryMode } from './mobile-push-delivery-policy'
import type { ExecutionHostPushCoverage } from './push-burst-slots'
import type { NotificationReplyTarget } from '../../../shared/notifications/notification-reply'
import type { PushReplyCategoryGate } from './push-reply-category-gate'

export type PushDispatcherRegistry = {
  listDevices(): readonly { deviceId: string; pushRegistration?: MobilePushRegistration }[]
  setPushRegistration(deviceId: string, registration: MobilePushRegistration | null): boolean
}

export type PushDispatcherOptions = {
  client: PushGatewayClient
  registry: PushDispatcherRegistry
  deliveryMode?: MobilePushDeliveryMode
  /** Test seam: lets a suite drive the single retry without real time. */
  scheduleRetry?: (run: () => void, delayMs: number) => void
  coverage?: ExecutionHostPushCoverage
  replyFor?: (event: MobileNotificationEvent) => NotificationReplyTarget | null
  replyCategory?: Pick<PushReplyCategoryGate, 'allows' | 'refresh'>
}

export type PushTarget = {
  deviceId: string
  registration: MobilePushRegistration
  /** The burst slot this push holds, so another host can learn whether it went out. */
  slot?: string
}
