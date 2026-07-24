import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { buildLocalNotificationData, type DesktopNotificationSource } from './notification-routing'
import {
  createSeenNotificationGuard,
  loadLastSeenSeq,
  saveLastSeenSeq,
  seenKeyForEvent
} from './notification-reconnect-catchup'

type NotificationEvent = {
  type: 'notification'
  source: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  // Desktop-assigned seq for reconnect catch-up (#8129); optional since older runtimes may omit it.
  notificationSeq?: number
}

type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
}

type SubscribeResult = {
  type: 'ready'
  subscriptionId: string
}

type ScheduledNotificationState = {
  identifier?: string
  pending?: Promise<string | null>
  dismissAfterSchedule?: boolean
}

const scheduledNotificationsByHostAndNotificationId = new Map<string, ScheduledNotificationState>()

// Why: keys never repeat and are only freed on desktop dismiss (which remote users often miss), so bound the map to stop unbounded growth.
const MAX_SCHEDULED_NOTIFICATIONS = 256
let maxScheduledNotifications = MAX_SCHEDULED_NOTIFICATIONS

function getStoredNotificationKey(hostId: string, notificationId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(notificationId)}`
}

// Evict oldest settled entries (never mid-schedule); Map iteration is insertion order so the first match is oldest.
function boundScheduledNotifications(): void {
  while (scheduledNotificationsByHostAndNotificationId.size > maxScheduledNotifications) {
    let evicted = false
    for (const [key, state] of scheduledNotificationsByHostAndNotificationId) {
      if (!state.pending) {
        scheduledNotificationsByHostAndNotificationId.delete(key)
        evicted = true
        break
      }
    }
    if (!evicted) {
      break
    }
  }
}

/** Test-only: override the cap (pass no arg to restore the default). */
export function setScheduledNotificationsMaxForTests(max?: number): void {
  maxScheduledNotifications = max ?? MAX_SCHEDULED_NOTIFICATIONS
}

export type NotificationPermissionState = {
  granted: boolean
  status: string
  canAskAgain: boolean
  authorizationReflectsUserChoice: boolean
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return {
    granted: status === 'granted',
    status,
    canAskAgain,
    // Why: Android <33 has no runtime notification permission, so "granted" is capability, not user consent.
    authorizationReflectsUserChoice:
      status === 'granted' && (Platform.OS !== 'android' || Number(Platform.Version) >= 33)
  }
}

// Why: re-read OS state every call — users can change it in Settings while Orca is backgrounded.
export async function ensureNotificationPermissions(): Promise<boolean> {
  const existing = await getNotificationPermissionState()
  if (existing.granted) {
    return true
  }

  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}

function configureNotificationChannel(): void {
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('orca-desktop', {
      name: 'Desktop Notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      lightColor: '#6366f1'
    })
  }
}

async function showLocalNotification(event: NotificationEvent, hostId: string): Promise<void> {
  const storedKey = event.notificationId
    ? getStoredNotificationKey(hostId, event.notificationId)
    : null

  if (!storedKey) {
    const enabled = await loadPushNotificationsEnabled()
    if (!enabled) {
      return
    }

    const granted = await ensureNotificationPermissions()
    if (!granted) {
      return
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: event.title,
        body: event.body,
        data: buildLocalNotificationData(event, hostId),
        ...(Platform.OS === 'android' ? { channelId: 'orca-desktop' } : {})
      },
      trigger: null
    })
    return
  }

  let state = scheduledNotificationsByHostAndNotificationId.get(storedKey)
  if (state?.pending) {
    return
  }
  if (!state) {
    state = {}
    scheduledNotificationsByHostAndNotificationId.set(storedKey, state)
  }
  const notificationState = state

  const pending = (async () => {
    const enabled = await loadPushNotificationsEnabled()
    if (!enabled) {
      return null
    }

    const granted = await ensureNotificationPermissions()
    if (!granted) {
      return null
    }

    if (notificationState.identifier) {
      await Notifications.dismissNotificationAsync(notificationState.identifier).catch(() => {})
      notificationState.identifier = undefined
    }

    return Notifications.scheduleNotificationAsync({
      content: {
        title: event.title,
        body: event.body,
        data: buildLocalNotificationData(event, hostId),
        ...(Platform.OS === 'android' ? { channelId: 'orca-desktop' } : {})
      },
      trigger: null
    })
  })()
  notificationState.pending = pending

  try {
    const scheduledIdentifier = await pending
    if (!scheduledIdentifier) {
      if (!notificationState.identifier) {
        scheduledNotificationsByHostAndNotificationId.delete(storedKey)
      }
      return
    }
    if (notificationState.dismissAfterSchedule) {
      notificationState.dismissAfterSchedule = false
      scheduledNotificationsByHostAndNotificationId.delete(storedKey)
      await Notifications.dismissNotificationAsync(scheduledIdentifier).catch(() => {})
      return
    }
    notificationState.identifier = scheduledIdentifier
    boundScheduledNotifications()
  } finally {
    if (notificationState.pending === pending) {
      notificationState.pending = undefined
      notificationState.dismissAfterSchedule = false
    }
  }
}

async function dismissLocalNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  if (!event.notificationId) {
    return
  }
  const storedKey = getStoredNotificationKey(hostId, event.notificationId)
  const state = scheduledNotificationsByHostAndNotificationId.get(storedKey)
  if (!state) {
    return
  }
  if (state.pending) {
    // Why: dismiss can arrive while the OS is still scheduling; defer it so no stale banner survives.
    state.dismissAfterSchedule = true
    return
  }
  if (!state.identifier) {
    return
  }
  scheduledNotificationsByHostAndNotificationId.delete(storedKey)
  await Notifications.dismissNotificationAsync(state.identifier).catch(() => {})
}

// Per-connection subscription; a reconnect `ready` triggers watermarked catch-up (#8129) so already-pushed events aren't re-sent.
export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  configureNotificationChannel()

  let subscriptionId: string | null = null
  let disposed = false
  // Highest seq delivered (live or replay) this connection; persisted per-host so cold start resumes from the right cut.
  let lastDeliveredSeq = 0
  // Why: defense-in-depth dedup for replayed events if the desktop's bounded buffer evicted across a reconnect boundary.
  const seenReplay = createSeenNotificationGuard()

  function deliverLive(
    type: 'notification' | 'dismiss',
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    if (event.notificationSeq != null && event.notificationSeq > lastDeliveredSeq) {
      lastDeliveredSeq = event.notificationSeq
      void saveLastSeenSeq(hostId, lastDeliveredSeq)
    }
    // Why (#8129): mark seen on the live path too, so a later replay of an already-pushed id dedups instead of double-pushing.
    const key = seenKeyForEvent(event)
    if (key) {
      seenReplay.add(key)
    }
    if (type === 'notification') {
      return showLocalNotification(event as NotificationEvent, hostId)
    }
    return dismissLocalNotification(event as DismissNotificationEvent, hostId)
  }

  // Why: desktop cuts by seq > lastSeenSeq, so re-fetching from the watermark is idempotent (seenReplay guards residual overlap).
  async function fetchMissed(): Promise<void> {
    if (disposed) {
      return
    }
    const missed = await client
      .sendRequest('notifications.getMissedSince', { lastSeenSeq: lastDeliveredSeq })
      .then((response) => {
        if (!response.ok) {
          return []
        }
        const result = response.result as { notifications?: unknown[] } | undefined
        return Array.isArray(result?.notifications) ? result.notifications : []
      })
      .catch(() => [])
    for (const raw of missed) {
      const event = raw as NotificationEvent | DismissNotificationEvent
      const key = seenKeyForEvent(event)
      if (key && seenReplay.has(key)) {
        continue
      }
      if (key) {
        seenReplay.add(key)
      }
      if (event.type === 'notification') {
        await deliverLive('notification', event)
      } else if (event.type === 'dismiss') {
        await deliverLive('dismiss', event)
      }
    }
  }

  // Why: seed the watermark lazily so subscribe() doesn't block on an AsyncStorage read.
  let watermarkLoaded = false
  void loadLastSeenSeq(hostId).then((seq) => {
    lastDeliveredSeq = Math.max(lastDeliveredSeq, seq)
    watermarkLoaded = true
  })

  function unsubscribeServer(id: string) {
    if (client.getState() === 'connected') {
      client.sendRequest('notifications.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  let reconnectReadyCount = 0
  const unsubscribeStream = client.subscribe('notifications.subscribe', {}, (data: unknown) => {
    const event = data as
      | NotificationEvent
      | DismissNotificationEvent
      | SubscribeResult
      | { type: 'end' }
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      reconnectReadyCount += 1
      if (disposed) {
        unsubscribeServer(subscriptionId)
        unsubscribeStream()
        return
      }
      // Why: only reconnects fetch missed; watermarkLoaded guards against fetching from a stale 0 (which re-pushes everything).
      if (reconnectReadyCount > 1 && watermarkLoaded) {
        void fetchMissed()
      }
      return
    }
    if (event.type === 'end') {
      if (disposed) {
        unsubscribeStream()
      }
      return
    }
    if (disposed) {
      return
    }
    if (event.type === 'notification') {
      void deliverLive('notification', event as NotificationEvent)
    } else if (event.type === 'dismiss') {
      void deliverLive('dismiss', event as DismissNotificationEvent)
    }
  })

  return () => {
    disposed = true
    // Why: drop the local stream first — readiness can race unmount; don't hold the callback while a subscription id is pending.
    unsubscribeStream()
    if (subscriptionId) {
      unsubscribeServer(subscriptionId)
    }
  }
}
