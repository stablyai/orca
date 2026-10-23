import { AppState, Platform, Vibration } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { loadHostCatalog } from '../transport/host-store'
import {
  COMPLETE_VIBRATION_PATTERN,
  DESKTOP_NOTIFICATION_CHANNEL_ID,
  DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID,
  DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID,
  URGENT_VIBRATION_PATTERN,
  ensureDesktopNotificationChannel
} from './desktop-notification-channel'
import type { DesktopNotificationDispatchEvent } from './desktop-notification-events'
import {
  publishInAppNotificationBanner,
  type NotificationTone
} from './in-app-notification-banner-store'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import { wasPushDismissed } from './push-dismissal-watermarks'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { OrcaPushPayload } from './push-payload'
import { isHostPushRegistered } from './push-registration'

const URGENT_TEXT_PATTERN = /\b(waiting for input|needs input|permission|approval|blocked)\b/i

export function classifyNotificationTone(
  event: Pick<DesktopNotificationDispatchEvent, 'source' | 'agentState' | 'title' | 'body'>
): NotificationTone {
  if (event.source === 'terminal-bell') {
    return 'urgent'
  }
  if (event.agentState === 'waiting' || event.agentState === 'blocked') {
    return 'urgent'
  }
  if (event.agentState === 'done' || event.source === 'test') {
    return 'complete'
  }
  const combined = `${event.title ?? ''} ${event.body ?? ''}`
  return URGENT_TEXT_PATTERN.test(combined) ? 'urgent' : 'complete'
}

export function resolveEventPaneKey(
  event: Pick<DesktopNotificationDispatchEvent, 'paneKey' | 'notificationId'>
): string | undefined {
  if (typeof event.paneKey === 'string' && event.paneKey.trim().length > 0) {
    return event.paneKey.trim()
  }
  if (typeof event.notificationId === 'string' && event.notificationId.startsWith('agent:')) {
    const parts = event.notificationId.split(':')
    if (parts.length >= 4 && parts[2]) {
      try {
        const decoded = decodeURIComponent(parts[2]).trim()
        if (decoded.length > 0) {
          return decoded
        }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

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
  const paneKey = resolveEventPaneKey(event)
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
    ...(paneKey ? { paneKey } : {}),
    ...(typeof event.worktreeId === 'string' && event.worktreeId.length > 0
      ? { worktreeId: event.worktreeId }
      : {}),
    ...(typeof event.executionHost === 'string' && event.executionHost.length > 0
      ? { executionHost: event.executionHost }
      : {})
  }
  if ((await wasPushDismissed(payload)) || isDisposed?.()) {
    return
  }
  const tone = classifyNotificationTone(event)
  const hostName = host.name?.trim() || hostId
  const osNotificationIdentifier = payload.notificationId
    ? `${hostFingerprint}:${payload.notificationId}`
    : undefined
  const { canPresentForegroundPush } = await import('./push-receive')
  const canScheduleOsBanner = await canPresentForegroundPush(payload)
  if (isDisposed?.()) {
    return
  }
  if (AppState.currentState === 'active') {
    publishInAppNotificationBanner({
      id: osNotificationIdentifier ?? `${hostId}:${Date.now()}`,
      tone,
      hostId,
      hostName,
      title: title || 'Orca',
      body,
      worktreeId: payload.worktreeId,
      paneKey: payload.paneKey,
      executionHost: payload.executionHost,
      notificationId: payload.notificationId,
      osNotificationIdentifier,
      createdAt: Date.now()
    })
    if (!canScheduleOsBanner && preferences.sound) {
      triggerVibrationPattern(tone)
    }
  }
  if (!canScheduleOsBanner) {
    return
  }
  await ensureDesktopNotificationChannel()
  const Notifications = await import('expo-notifications')
  const channelId = notificationChannelId(preferences.sound, tone)
  const vibrationPattern = tone === 'urgent' ? URGENT_VIBRATION_PATTERN : COMPLETE_VIBRATION_PATTERN
  const subtitleLabel =
    tone === 'urgent'
      ? event.source === 'terminal-bell'
        ? 'Terminal bell'
        : 'Needs input'
      : 'Task complete'
  await Notifications.scheduleNotificationAsync({
    ...(osNotificationIdentifier ? { identifier: osNotificationIdentifier } : {}),
    content: {
      title: `${tone === 'urgent' ? '⚡ ' : '✅ '}${title || 'Orca'}`,
      subtitle: `${hostName} · ${subtitleLabel}`,
      body,
      color: tone === 'urgent' ? '#f59e0b' : '#10b981',
      vibrate: vibrationPattern,
      priority: 'max',
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
  const [preferences, hosts, Notifications] = await Promise.all([
    loadNotificationDeliveryPreferences(),
    loadHostCatalog().catch(() => []),
    import('expo-notifications')
  ])
  const primaryHost = hosts[0]
  const hostName = primaryHost?.name?.trim() || 'Orca Desktop'
  const channelId = notificationChannelId(preferences.sound, 'complete')
  if (AppState.currentState === 'active') {
    publishInAppNotificationBanner({
      id: `test:${Date.now()}`,
      tone: 'complete',
      ...(primaryHost ? { hostId: primaryHost.id } : {}),
      hostName,
      title: 'Orca',
      body: 'Test notification from Orca.',
      createdAt: Date.now()
    })
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '✅ Orca',
      subtitle: `${hostName} · Task complete`,
      body: 'Test notification from Orca.',
      color: '#10b981',
      vibrate: COMPLETE_VIBRATION_PATTERN,
      priority: 'max',
      sound: preferences.sound ? 'default' : false
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  })
}

function notificationChannelId(sound: boolean, tone: NotificationTone): string {
  if (!sound) {
    return `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`
  }
  return tone === 'urgent'
    ? DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID
    : DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID
}

function triggerVibrationPattern(tone: NotificationTone): void {
  try {
    Vibration?.vibrate?.(tone === 'urgent' ? URGENT_VIBRATION_PATTERN : COMPLETE_VIBRATION_PATTERN)
  } catch {
    // Best-effort tactile feedback when OS banner is suppressed while viewing.
  }
}
