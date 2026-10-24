import { AppState, Platform } from 'react-native'
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
  dismissConsumedTrayNotifications,
  dismissSupersededPaneTrayNotifications,
  isNotificationTargetConsumed
} from './consumed-notification-tray-dismissal'
import {
  publishInAppNotificationBanner,
  type NotificationTone
} from './in-app-notification-banner-store'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import { shouldSuppressNotificationWhileViewing } from './notification-viewing-policy'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { OrcaPushPayload } from './push-payload'
import { isHostPushRegistered } from './push-registration'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'

const URGENT_TEXT_PATTERN = /\b(waiting for input|needs input|permission|approval|blocked)\b/i

function tryDecodeSegment(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const decoded = decodeURIComponent(raw).trim()
    return decoded.length > 0 ? decoded : undefined
  } catch {
    return undefined
  }
}

export function classifyNotificationTone(
  event: Pick<DesktopNotificationDispatchEvent, 'source' | 'agentState' | 'title' | 'body'>
): NotificationTone {
  if (event.source === 'terminal-bell') {
    return 'complete'
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
  event: Pick<DesktopNotificationDispatchEvent, 'paneKey' | 'notificationId' | 'structuredOrigin'>
): string | undefined {
  if (typeof event.paneKey === 'string' && event.paneKey.trim().length > 0) {
    return event.paneKey.trim()
  }
  const structuredSessionId = event.structuredOrigin?.sessionId?.trim()
  if (structuredSessionId) {
    return structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(structuredSessionId),
      structuredSessionId
    )
  }
  if (typeof event.notificationId === 'string') {
    const parts = event.notificationId.split(':')
    if (event.notificationId.startsWith('agent:') && parts.length >= 4) {
      return tryDecodeSegment(parts[2])
    }
    if (event.notificationId.startsWith('agent-attention:') && parts.length >= 3) {
      const sessionId = tryDecodeSegment(parts[2])
      return sessionId
        ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
        : undefined
    }
  }
  return undefined
}

export function resolveEventWorktreeId(
  event: Pick<DesktopNotificationDispatchEvent, 'worktreeId' | 'notificationId'>
): string | undefined {
  if (typeof event.worktreeId === 'string' && event.worktreeId.trim().length > 0) {
    return event.worktreeId.trim()
  }
  if (
    typeof event.notificationId === 'string' &&
    (event.notificationId.startsWith('agent:') ||
      event.notificationId.startsWith('agent-attention:'))
  ) {
    const parts = event.notificationId.split(':')
    if (parts.length >= 3) {
      return tryDecodeSegment(parts[1])
    }
  }
  return undefined
}

export async function presentSocketNotificationFallback(
  event: DesktopNotificationDispatchEvent,
  hostId: string,
  isDisposed?: () => boolean
): Promise<void> {
  if (
    event.desktopAllowed === false ||
    event.legacySocketAllowed === false ||
    event.agentState === 'working'
  ) {
    return
  }
  const title = event.title?.trim() ?? ''
  const body = event.body?.trim() ?? ''
  if (
    (title.length === 0 && body.length === 0) ||
    event.source === 'terminal-bell' ||
    title.startsWith('Bell in ')
  ) {
    return
  }
  if ((await isHostPushRegistered(hostId)) || !(await loadPushNotificationsEnabled())) {
    return
  }
  const preferences = await loadNotificationDeliveryPreferences()
  if (preferences.onlyWhenDesktopAway && event.desktopAway === false) {
    return
  }
  const hosts = await loadHostCatalog().catch(() => [])
  const host = hosts.find((item) => item.id === hostId)
  const hostFingerprint = host ? deriveHostFingerprint(host.publicKeyB64) : undefined
  if (!host || !hostFingerprint) {
    return
  }
  const paneKey = resolveEventPaneKey(event)
  const worktreeId = resolveEventWorktreeId(event)
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
    ...(worktreeId ? { worktreeId } : {}),
    ...(typeof event.executionHost === 'string' && event.executionHost.length > 0
      ? { executionHost: event.executionHost }
      : {})
  }
  const { canPresentForegroundPush } = await import('./push-receive')
  const suppressedWhileViewing = shouldSuppressNotificationWhileViewing(
    payload,
    hostId,
    preferences.suppressWhileViewing
  )
  console.info(
    `[notif-policy] id=${payload.notificationId ?? 'none'} wt=${payload.worktreeId ?? 'none'} pane=${payload.paneKey ?? 'none'} suppressed=${suppressedWhileViewing}`
  )
  if (
    !(await canPresentForegroundPush(payload, hostId)) ||
    suppressedWhileViewing ||
    isDisposed?.()
  ) {
    return
  }
  const tone = classifyNotificationTone(event)
  const hostName = host.name?.trim() || hostId
  const osNotificationIdentifier = payload.notificationId
    ? `${hostFingerprint}:${payload.notificationId}`
    : payload.worktreeId && payload.paneKey
      ? `${hostFingerprint}:pane:${payload.worktreeId}:${payload.paneKey}`
      : `${hostId}:${Date.now()}`
  if (
    AppState.currentState === 'active' &&
    !shouldSuppressNotificationWhileViewing(payload, hostId, preferences.suppressWhileViewing)
  ) {
    publishInAppNotificationBanner({
      id: osNotificationIdentifier,
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
  }
  await ensureDesktopNotificationChannel()
  if (
    isDisposed?.() ||
    shouldSuppressNotificationWhileViewing(payload, hostId, preferences.suppressWhileViewing) ||
    isNotificationTargetConsumed({ osNotificationIdentifier, notificationId: payload.notificationId })
  ) {
    return
  }
  const Notifications = await import('expo-notifications')
  const channelId = notificationChannelId(preferences.sound, tone)
  const subtitleLabel =
    tone === 'urgent'
      ? 'Needs input'
      : (event.source as string | undefined) === 'terminal-bell'
        ? 'Terminal bell'
        : 'Task complete'
  await Notifications.scheduleNotificationAsync({
    identifier: osNotificationIdentifier,
    content: {
      title: `${tone === 'urgent' ? '⚡ ' : '✅ '}${title || 'Orca'}`,
      subtitle: `${hostName} · ${subtitleLabel}`,
      body,
      color: tone === 'urgent' ? '#f59e0b' : '#10b981',
      vibrate: tone === 'urgent' ? URGENT_VIBRATION_PATTERN : COMPLETE_VIBRATION_PATTERN,
      priority: 'max',
      data: { hostId, ...payload },
      sound: preferences.sound ? 'default' : false
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  })
  const targetMeta = {
    hostId,
    hostFingerprint,
    worktreeId: payload.worktreeId,
    paneKey: payload.paneKey,
    executionHost: payload.executionHost
  }
  if (isNotificationTargetConsumed({ osNotificationIdentifier, notificationId: payload.notificationId })) {
    await dismissConsumedTrayNotifications({
      ...targetMeta,
      osNotificationIdentifier,
      notificationId: payload.notificationId
    })
    return
  }
  await dismissSupersededPaneTrayNotifications(targetMeta, osNotificationIdentifier)
}

export async function sendLocalNotificationDisplayTest(): Promise<void> {
  await ensureDesktopNotificationChannel()
  const [preferences, hosts, Notifications] = await Promise.all([
    loadNotificationDeliveryPreferences(),
    loadHostCatalog().catch(() => []),
    import('expo-notifications')
  ])
  const hostName = hosts[0]?.name?.trim() || 'Orca Desktop'
  const channelId = notificationChannelId(preferences.sound, 'complete')
  const scheduledId = await Notifications.scheduleNotificationAsync({
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
  const osNotificationIdentifier =
    typeof scheduledId === 'string' && scheduledId.length > 0 ? scheduledId : `test:${Date.now()}`
  if (AppState.currentState === 'active') {
    publishInAppNotificationBanner({
      id: osNotificationIdentifier,
      tone: 'complete',
      hostName,
      title: 'Orca',
      body: 'Test notification from Orca.',
      osNotificationIdentifier,
      createdAt: Date.now()
    })
  }
}

function notificationChannelId(sound: boolean, tone: NotificationTone): string {
  if (!sound) {
    return `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`
  }
  return tone === 'urgent'
    ? DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID
    : DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID
}
