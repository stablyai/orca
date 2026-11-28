import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import {
  handleNotificationReply,
  recoverInterruptedNotificationReplies
} from './notification-reply-response'
import { ensureNotificationReplyCategory } from './notification-reply-category'
import { pendingNativeReplies } from './notification-reply-native'

const TASK_NAME = 'orca-notification-reply'
TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  TASK_NAME,
  async ({ data, error }) => {
    if (!error && data && 'actionIdentifier' in data) {
      await handleNotificationReply(data)
    }
  }
)

// Register at entry: a notification response may launch JS without mounting a route.
Notifications.addNotificationResponseReceivedListener((response) => {
  void handleNotificationReply(response).catch(() => {})
})
export async function registerNotificationReplyTask(): Promise<void> {
  await ensureNotificationReplyCategory()
  await recoverInterruptedNotificationReplies()
  for (const response of await pendingNativeReplies()) {
    await handleNotificationReply(response)
  }
  if (await TaskManager.isAvailableAsync()) {
    await Notifications.registerTaskAsync(TASK_NAME)
  }
}
