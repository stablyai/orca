import { wasPushDismissed } from './push-dismissal-watermarks'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import { AppState } from 'react-native'
import { readOrcaPushPayload } from './push-payload'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { openSealedPushData, type OpenedPush } from './push-sealed-payload'
import { canPresentForegroundPush } from './push-receive'
import { DESKTOP_NOTIFICATION_CHANNEL_ID } from './desktop-notification-channel'

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
    const tag = raw && typeof raw === 'object' && 'tag' in raw ? raw.tag : undefined
    const opened = await openSealedPushData(raw).catch(() => null)
    if (opened) {
      raw = opened.data
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
      return
    }
    if (opened?.opened && payload && payload.kind !== 'dismiss' && typeof tag === 'string') {
      await replaceSealedPlaceholder(tag, opened, payload)
    }
  }
)

// Why: with Orca in the background Expo has already shown the sealed push's generic
// placeholder under the FCM tag. Re-posting under the same tag swaps in the real
// text; the silent channel keeps the swap from alerting a second time. In the
// foreground android-foreground-push.ts presents instead, so this stays out.
async function replaceSealedPlaceholder(
  tag: string,
  opened: OpenedPush,
  payload: NonNullable<ReturnType<typeof readOrcaPushPayload>>
): Promise<void> {
  if (AppState.currentState === 'active') {
    return
  }
  if (!(await canPresentForegroundPush(payload))) {
    await Notifications.dismissNotificationAsync(tag)
    return
  }
  await Notifications.scheduleNotificationAsync({
    identifier: tag,
    content: {
      title: opened.title ?? 'Orca',
      body: opened.body ?? '',
      data: opened.data,
      sound: false
    },
    trigger: { channelId: `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent` }
  })
}

export async function registerPushDismissalTask(): Promise<void> {
  if (await TaskManager.isAvailableAsync()) {
    await Notifications.registerTaskAsync(TASK_NAME)
  }
}
