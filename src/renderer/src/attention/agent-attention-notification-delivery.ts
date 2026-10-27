/** Share delivery, success sound and blocked-permission fallback across surfaces; callers own message content. Main applies banner preferences after mobile fanout, so callers cannot promise a banner. */
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { showBlockedNotificationFallbackToast } from '@/lib/blocked-notification-fallback'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult
} from '../../../shared/notification-settings-types'

export type AgentAttentionNotificationSound = {
  customSoundId: string
  customSoundVolume: number | null
}

export function deliverAgentAttentionNotification(
  request: NotificationDispatchRequest,
  sound: AgentAttentionNotificationSound,
  onResult?: (result: NotificationDispatchResult | null) => void
): void {
  void window.api.notifications
    .dispatch(request)
    .then((result) => {
      onResult?.(result)
      if (result.delivered) {
        void playDesktopNotificationSound(sound.customSoundId, sound.customSoundVolume)
        return
      }
      // Surface blocked macOS permission in-app rather than silently losing the notification.
      if (result.reason === 'blocked-by-system') {
        showBlockedNotificationFallbackToast()
      }
    })
    .catch((err) => {
      onResult?.(null)
      console.warn('Failed to dispatch notification:', err)
    })
}

/** The sound preferences one delivery reads, defaulted the way the dispatch path always has. */
export function readAgentAttentionNotificationSound(settings: {
  notifications?: { customSoundId?: string; customSoundVolume?: number | null } | undefined
}): AgentAttentionNotificationSound {
  return {
    customSoundId: settings.notifications?.customSoundId ?? 'system',
    customSoundVolume: settings.notifications?.customSoundVolume ?? null
  }
}
