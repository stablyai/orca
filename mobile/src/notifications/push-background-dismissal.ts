import { wasPushDismissed } from './push-dismissal-watermarks'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload } from './push-payload'
import { dismissPresentedPushNotification } from './push-tray-dismissal'

const TASK_NAME = 'orca-push-dismissal'

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  TASK_NAME,
  async ({ data, error }) => {
    if (error || !data || 'actionIdentifier' in data) {
      return
    }
    let raw: unknown = data.data
    if (typeof data.data.dataString === 'string') {
      try {
        raw = JSON.parse(data.data.dataString)
      } catch {
        return
      }
    }
    const payload = readOrcaPushPayload(raw)
    if (
      payload?.notificationId &&
      (payload.kind === 'dismiss' || (await wasPushDismissed(payload)))
    ) {
      await dismissPresentedPushNotification(
        payload.notificationId,
        payload.hostFingerprint,
        payload
      )
    }
  }
)

export async function registerPushDismissalTask(): Promise<void> {
  if (await TaskManager.isAvailableAsync()) {
    await Notifications.registerTaskAsync(TASK_NAME)
  }
}
