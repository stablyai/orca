import {
  attachMobilePushPrompt,
  MOBILE_PUSH_NOTIFICATION_MAX_BYTES
} from '../../../shared/mobile-push-prompt'
import type { MobilePushPrompt } from '../../../shared/notifications/mobile-push-contract'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import type { DesktopPushPrompt } from './desktop-push-prompt'
import type { PushSendNotification } from './push-gateway-client'

const capturedPrompts = new WeakMap<MobileNotificationEvent, MobilePushPrompt | null>()

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** Remember the pane's prompt before a coverage wait can let a newer one replace it. */
export function capturePushPrompt(
  event: MobileNotificationEvent,
  prompt: DesktopPushPrompt | undefined
): void {
  if (event.type !== 'notification' || !prompt) {
    capturedPrompts.set(event, null)
    return
  }
  capturedPrompts.set(event, prompt.promptFor(event))
}

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
    const pending = capturedPrompts.get(event) ?? null
    return attachMobilePushPrompt(notification, pending, prompt?.gate.allows() === true)
  } catch (error) {
    console.warn('[push] prompt fields omitted', error)
    return notification
  }
}

/**
 * Silent phones add `sound: false` after the prompt is fitted.
 * Drop the prompt, then the category, when that flag would pass the gateway limit.
 */
export function notificationForSound(
  notification: PushSendNotification,
  sound: boolean
): PushSendNotification {
  if (sound) {
    return notification
  }
  const silent = { ...notification, sound: false }
  if (jsonBytes(silent) <= MOBILE_PUSH_NOTIFICATION_MAX_BYTES) {
    return silent
  }
  const { prompt: _prompt, ...withoutPrompt } = silent
  if (jsonBytes(withoutPrompt) <= MOBILE_PUSH_NOTIFICATION_MAX_BYTES) {
    return withoutPrompt
  }
  const { category: _category, ...base } = withoutPrompt
  return jsonBytes(base) <= MOBILE_PUSH_NOTIFICATION_MAX_BYTES ? base : silent
}
