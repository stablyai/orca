import { randomUUID } from 'node:crypto'
import type { MobilePushRegistration } from '../../../shared/mobile-push-contract'
import { sealPushNotification } from './push-e2e-seal'
import type { PushSendNotification } from './push-gateway-client'

/** The explicit test push, sealed like every real push to this phone so the test proves it can open them. */
export function buildTestPushNotification(
  registration: MobilePushRegistration,
  deviceToken: string
): PushSendNotification {
  const notification: PushSendNotification = {
    source: 'terminal-bell',
    agentState: null,
    title: 'Test notification',
    body: '',
    notificationId: randomUUID(),
    notificationEpoch: randomUUID(),
    notificationSeq: 0,
    expiresAt: Date.now() + 300_000,
    sound: registration.filter.sound !== false
  }
  return registration.sealedContent ? sealPushNotification(notification, deviceToken) : notification
}
