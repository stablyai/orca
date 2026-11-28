import { requireNativeModule } from 'expo-modules-core'
import type * as Notifications from 'expo-notifications'
import { notificationReplyResponseId } from './notification-reply-identity'

type NativeReply = Notifications.NotificationResponse & { nativeReplyId: string }

const native = requireNativeModule<{
  pendingReplies(): Promise<NativeReply[]>
  completeReply(id: string): Promise<void>
}>('OrcaNotificationDismissal')

export const pendingNativeReplies = () => native.pendingReplies()
export async function completeNativeReply(
  response: Notifications.NotificationResponse
): Promise<void> {
  const id = notificationReplyResponseId(response)
  const pending = await native.pendingReplies()
  await Promise.all(
    pending
      .filter((reply) => notificationReplyResponseId(reply) === id)
      .map((reply) => native.completeReply(reply.nativeReplyId))
  )
}
