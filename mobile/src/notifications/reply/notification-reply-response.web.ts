import type { NotificationResponse } from 'expo-notifications'

export async function handleNotificationReply(_response: NotificationResponse): Promise<boolean> {
  return false
}

export async function restoreNotificationReplyDraft(_data: unknown): Promise<void> {}

export async function recoverInterruptedNotificationReplies(): Promise<void> {}
