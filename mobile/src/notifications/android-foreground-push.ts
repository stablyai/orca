import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { canPresentForegroundPush } from './push-receive'
import { readOrcaPushPayload } from './push-payload'
import { openSealedPushData } from './push-sealed-payload'

export function startAndroidForegroundPushPresentation(): () => void {
  if (Platform.OS !== 'android') {
    return () => {}
  }

  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    const { trigger, content, identifier } = notification.request
    // Expo emits foreground data pushes but only auto-presents them in the background.
    if (
      !trigger ||
      !('type' in trigger) ||
      trigger.type !== 'push' ||
      trigger.remoteMessage?.notification !== null
    ) {
      return
    }
    const payload = readOrcaPushPayload(content.data)
    if (!payload || payload.kind === 'dismiss' || (!content.title && !content.body)) {
      return
    }

    void present().catch((error: unknown) => {
      console.warn('[push] Foreground notification presentation failed', error)
    })

    async function present(): Promise<void> {
      const opened = await openSealedPushData(content.data).catch(() => null)
      const presentedPayload = opened ? readOrcaPushPayload(opened.data) : payload
      if (!presentedPayload || !(await canPresentForegroundPush(presentedPayload))) {
        return
      }
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title: opened?.opened ? (opened.title ?? content.title) : content.title,
          body: opened?.opened ? (opened.body ?? '') : content.body,
          data: opened ? opened.data : content.data,
          sound: content.sound === 'default' ? 'default' : false
        },
        trigger:
          typeof content.data?.channelId === 'string' ? { channelId: content.data.channelId } : null
      })
    }
  })
  return () => subscription.remove()
}
