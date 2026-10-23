import { Platform } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { loadHostCatalog } from '../transport/host-store'
import {
  DESKTOP_NOTIFICATION_CHANNEL_ID,
  ensureDesktopNotificationChannel
} from './desktop-notification-channel'
import type { DesktopNotificationDispatchEvent } from './desktop-notification-events'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { OrcaPushPayload } from './push-payload'
import { isHostPushRegistered } from './push-registration'

export async function presentSocketNotificationFallback(
  event: DesktopNotificationDispatchEvent,
  hostId: string,
  isDisposed?: () => boolean
): Promise<void> {
  if (event.desktopAllowed === false || event.legacySocketAllowed === false) {
    return
  }
  const title = event.title?.trim() ?? ''
  const body = event.body?.trim() ?? ''
  if (title.length === 0 && body.length === 0) {
    return
  }
  if (await isHostPushRegistered(hostId)) {
    return
  }
  if (!(await loadPushNotificationsEnabled())) {
    return
  }
  const preferences = await loadNotificationDeliveryPreferences()
  if (preferences.onlyWhenDesktopAway && event.desktopAway === false) {
    return
  }
  const hosts = await loadHostCatalog().catch(() => [])
  const host = hosts.find((item) => item.id === hostId)
  if (!host) {
    return
  }
  const hostFingerprint = deriveHostFingerprint(host.publicKeyB64)
  if (!hostFingerprint) {
    return
  }
  const payload: OrcaPushPayload = {
    kind: 'alert',
    hostFingerprint,
    ...(typeof event.notificationId === 'string' && event.notificationId.length > 0
      ? { notificationId: event.notificationId }
      : {}),
    ...(typeof event.notificationSeq === 'number' && Number.isSafeInteger(event.notificationSeq)
      ? { notificationSeq: event.notificationSeq }
      : {}),
    ...(typeof event.notificationEpoch === 'string' && event.notificationEpoch.length > 0
      ? { notificationEpoch: event.notificationEpoch }
      : {}),
    ...(typeof event.paneKey === 'string' && event.paneKey.length > 0
      ? { paneKey: event.paneKey }
      : {}),
    ...(typeof event.worktreeId === 'string' && event.worktreeId.length > 0
      ? { worktreeId: event.worktreeId }
      : {}),
    ...(typeof event.executionHost === 'string' && event.executionHost.length > 0
      ? { executionHost: event.executionHost }
      : {})
  }
  const { canPresentForegroundPush } = await import('./push-receive')
  if (!(await canPresentForegroundPush(payload)) || isDisposed?.()) {
    return
  }
  await ensureDesktopNotificationChannel()
  const Notifications = await import('expo-notifications')
  const channelId = notificationChannelId(preferences.sound)
  await Notifications.scheduleNotificationAsync({
    ...(payload.notificationId
      ? { identifier: `${hostFingerprint}:${payload.notificationId}` }
      : {}),
    content: {
      title: title || 'Orca',
      body,
      data: {
        hostId,
        ...payload
      },
      sound: preferences.sound ? 'default' : false
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  })
}

export async function sendLocalNotificationDisplayTest(): Promise<void> {
  await ensureDesktopNotificationChannel()
  const [preferences, Notifications] = await Promise.all([
    loadNotificationDeliveryPreferences(),
    import('expo-notifications')
  ])
  const channelId = notificationChannelId(preferences.sound)
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Orca',
      body: 'Test notification from Orca.',
      sound: preferences.sound ? 'default' : false
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  })
}

function notificationChannelId(sound: boolean): string {
  return sound ? DESKTOP_NOTIFICATION_CHANNEL_ID : `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`
}
