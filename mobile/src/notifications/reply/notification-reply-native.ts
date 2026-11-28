import type * as Notifications from 'expo-notifications'
export const pendingNativeReplies = async (): Promise<Notifications.NotificationResponse[]> => []
export const completeNativeReply = async (
  _response: Notifications.NotificationResponse
): Promise<void> => {}
