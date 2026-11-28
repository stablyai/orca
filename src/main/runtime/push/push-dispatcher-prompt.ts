import { attachMobilePushPrompt } from '../../../shared/mobile-push-prompt'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import type { DesktopPushPrompt } from './desktop-push-prompt'
import type { PushSendNotification } from './push-gateway-client'

/** A lookup failure must still deliver the alert the host already built. */
export function notificationWithAgentPrompt(
  notification: PushSendNotification,
  event: MobileNotificationEvent,
  prompt: DesktopPushPrompt | undefined
): PushSendNotification {
  if (notification.agentState !== 'needs-input') {
    return notification
  }
  try {
    prompt?.gate.refresh()
    const pending = prompt?.promptFor(event) ?? null
    return attachMobilePushPrompt(notification, pending, prompt?.gate.allows() === true)
  } catch (error) {
    console.warn('[push] prompt fields omitted', error)
    return notification
  }
}
