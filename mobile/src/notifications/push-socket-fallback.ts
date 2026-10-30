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
  ingestBridgeWorktreeListPayload,
  readBridgeNotificationAgentContext
} from './bridge-session-viewing-tracker'
import { resumeWorktreeListRead } from '../agent-history/mobile-agent-history-operations'
import type { MobilePushDismissalRpcSender } from './push-dismissal-operations'
import {
  dismissInAppNotificationBannerById,
  publishInAppNotificationBanner,
  type NotificationTone
} from './in-app-notification-banner-store'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import {
  describeNotificationViewing,
  shouldSuppressNotificationWhileViewing
} from './notification-viewing-policy'
import { wasPushDismissed } from './push-dismissal-watermarks'
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
    return decodeURIComponent(raw).trim() || undefined
  } catch {
    return undefined
  }
}

function normalizeSingleLineText(raw: string | undefined): string {
  return raw?.replace(/\s+/g, ' ').trim() ?? ''
}

export function notificationToneIcon(tone: NotificationTone, title?: string): string {
  if (tone === 'urgent') {
    return '⚡'
  }
  return title?.startsWith('Bell in ') ? '🔔' : '✅'
}

export function buildNotificationDisplayContent(input: {
  tone: NotificationTone
  title?: string
  prompt?: string
  reply?: string
}): {
  icon: string
  title: string
  prompt: string
  reply: string
  osTitle: string
  osBody: string
} {
  const title = normalizeSingleLineText(input.title) || 'Orca'
  const icon = notificationToneIcon(input.tone, title)
  const prompt = normalizeSingleLineText(input.prompt)
  const reply = normalizeSingleLineText(input.reply)
  const osBody = [prompt, reply].filter((line) => line.length > 0).join('\n')
  return {
    icon,
    title,
    prompt,
    reply,
    osTitle: `${icon} ${title}`,
    osBody
  }
}

export function classifyNotificationTone(
  event: Pick<DesktopNotificationDispatchEvent, 'source' | 'agentState' | 'title' | 'body'>
): NotificationTone {
  if (event.source === 'terminal-bell' || event.agentState === 'done' || event.source === 'test') {
    return 'complete'
  }
  if (event.agentState === 'waiting' || event.agentState === 'blocked') {
    return 'urgent'
  }
  return URGENT_TEXT_PATTERN.test(`${event.title ?? ''} ${event.body ?? ''}`) ? 'urgent' : 'complete'
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
    return tryDecodeSegment(event.notificationId.split(':')[1])
  }
  return undefined
}

export async function presentSocketNotificationFallback(
  event: DesktopNotificationDispatchEvent,
  hostId: string,
  isDisposed?: () => boolean,
  client?: MobilePushDismissalRpcSender
): Promise<void> {
  const title = event.title?.trim() ?? ''
  const body = event.body?.trim() ?? ''
  if (
    event.desktopAllowed === false ||
    event.legacySocketAllowed === false ||
    event.agentState === 'working' ||
    (title.length === 0 && body.length === 0) ||
    event.source === 'terminal-bell' ||
    title.startsWith('Bell in ') ||
    (await isHostPushRegistered(hostId)) ||
    !(await loadPushNotificationsEnabled())
  ) {
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
    `[notif-policy] id=${payload.notificationId ?? 'none'} host=${hostId} wt=${payload.worktreeId ?? 'none'} pane=${payload.paneKey ?? 'none'} exec=${payload.executionHost ?? 'none'} pref=${preferences.suppressWhileViewing} suppressed=${suppressedWhileViewing} ${describeNotificationViewing()}`
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
  if (!event.agentPrompt?.trim() && client && payload.worktreeId) {
    const psResponse = await resumeWorktreeListRead
      .request(client, {}, { timeoutMs: 2000 })
      .catch(() => null)
    const psAccepted = psResponse ? resumeWorktreeListRead.interpret(psResponse) : null
    if (psAccepted?.accepted) {
      ingestBridgeWorktreeListPayload(hostId, psAccepted.value)
    }
    if (isDisposed?.()) {
      return
    }
  }
  const fallbackContext = readBridgeNotificationAgentContext(
    hostId,
    payload.worktreeId,
    payload.paneKey
  )
  const display = buildNotificationDisplayContent({
    tone,
    title,
    prompt: event.agentPrompt ?? fallbackContext.prompt,
    reply: event.agentLastAssistantMessage || body || fallbackContext.lastAssistantMessage
  })
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
      ...payload,
      id: osNotificationIdentifier,
      tone,
      hostId,
      hostName,
      title: display.title,
      ...(display.prompt ? { prompt: display.prompt } : {}),
      body: display.reply,
      osNotificationIdentifier,
      createdAt: Date.now()
    })
  }
  const targetMeta = {
    hostId,
    hostFingerprint,
    worktreeId: payload.worktreeId,
    paneKey: payload.paneKey,
    executionHost: payload.executionHost,
    osNotificationIdentifier,
    notificationId: payload.notificationId
  }
  await ensureDesktopNotificationChannel()
  if (
    isDisposed?.() ||
    shouldSuppressNotificationWhileViewing(payload, hostId, preferences.suppressWhileViewing) ||
    isNotificationTargetConsumed(targetMeta)
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
      title: display.osTitle,
      subtitle: `${hostName} · ${subtitleLabel}`,
      body: display.osBody,
      color: tone === 'urgent' ? '#f59e0b' : '#10b981',
      vibrate: tone === 'urgent' ? URGENT_VIBRATION_PATTERN : COMPLETE_VIBRATION_PATTERN,
      priority: 'max',
      data: { hostId, ...payload },
      sound: preferences.sound ? 'default' : false
    },
    trigger: Platform.OS === 'android' ? { channelId } : null
  })
  if (
    payload.notificationId &&
    payload.notificationEpoch &&
    payload.notificationSeq !== undefined &&
    (await wasPushDismissed(payload))
  ) {
    dismissInAppNotificationBannerById(payload.notificationId, hostId, payload)
    const { dismissPresentedPushNotification } = await import('./push-tray-dismissal')
    await dismissPresentedPushNotification(payload.notificationId, hostFingerprint, payload)
    return
  }
  if (isNotificationTargetConsumed(targetMeta)) {
    await dismissConsumedTrayNotifications(targetMeta)
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
  return !sound
    ? `${DESKTOP_NOTIFICATION_CHANNEL_ID}-silent`
    : tone === 'urgent'
      ? DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID
      : DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID
}
