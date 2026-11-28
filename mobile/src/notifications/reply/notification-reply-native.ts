import type * as Notifications from 'expo-notifications'
export const pendingNativeReplies = async (): Promise<Notifications.NotificationResponse[]> => []
export const completeNativeReply = async (_id: string): Promise<void> => {}
