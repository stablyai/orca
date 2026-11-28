import { requireNativeModule } from 'expo-modules-core'
import type * as Notifications from 'expo-notifications'

const native = requireNativeModule<{
  pendingReplies(): Promise<Notifications.NotificationResponse[]>
  completeReply(id: string): Promise<void>
}>('OrcaNotificationDismissal')

export const pendingNativeReplies = () => native.pendingReplies()
export const completeNativeReply = (id: string) => native.completeReply(id)
