import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { buildLocalNotificationData, type DesktopNotificationSource } from './notification-routing'

type NotificationEvent = {
  type: 'notification'
  source: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  // Mirrors the desktop-assigned MobileNotificationEvent.notificationSeq used
  // for reconnect catch-up (#8129). Optional because older runtimes / non-
  // replay events may omit it.
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

// Why: notificationId embeds a per-completion timestamp (buildAgentNotificationId),
// so every agent-task-complete inserts a new, never-reused key. Entries are only
// removed when the desktop sends a matching dismiss — which a remote mobile user
// (not at the desktop) frequently never gets — so the map grew for the app's whole
// life. Bound it; a settled entry only retains a small identifier used for later
// programmatic dismissal, unnecessary for long-past completions.
const MAX_SCHEDULED_NOTIFICATIONS = 256
let maxScheduledNotifications = MAX_SCHEDULED_NOTIFICATIONS

function getStoredNotificationKey(hostId: string, notificationId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(notificationId)}`
}

// Why: the highest desktop notification seq this device has delivered is
// persisted per-host so it survives app restarts. On reconnect we send it to
// notifications.getMissedSince as the catch-up watermark — the desktop then
// returns only notifications dispatched after it, so we never re-push a
// notification we already delivered (#8129). The in-memory seen-set below is a
// second guard against double-delivery for events that arrive on both the live
// stream and a replay (e.g. a brief liveness spell before a reap).
const LAST_SEQ_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsLastSeq:'

function lastSeqStorageKey(hostId: string): string {
  return LAST_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
}

async function loadLastSeenSeq(hostId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(lastSeqStorageKey(hostId))
    const parsed = raw == null ? 0 : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

async function saveLastSeenSeq(hostId: string, seq: number): Promise<void> {
  if (!Number.isFinite(seq) || seq <= 0) {
    return
  }
  try {
    await AsyncStorage.setItem(lastSeqStorageKey(hostId), String(seq))
  } catch {
    // Why: durability of the watermark is best-effort. If it fails we simply
    // under-fetch on the next reconnect and the live stream covers the gap.
  }
}

// Why: bounded in-memory dedup window for notificationIds/dismiss ids observed
// on the current connection. The desktop already dedupes by seq on replay, but
// a socket that flickers background→foreground→background can deliver an event
// on the live stream and again in a replay; the seen-set guarantees each
// notificationId maps to at most one local push for the connection lifetime.
// Bounded so a long-lived session can't grow without limit (matches the
// desktop's 256-entry replay buffer and the 256 scheduled-notification cap).
const RECENTLY_SEEN_CAP = 512

function createSeenNotificationGuard(): {
  has: (id: string) => boolean
  add: (id: string) => void
} {
  const seen = new Set<string>()
  return {
    has(id: string): boolean {
      return seen.has(id)
    },
    add(id: string): void {
      seen.add(id)
      if (seen.size > RECENTLY_SEEN_CAP) {
        // Why: insertion order; the oldest entries are first. Drop one to stay
        // bounded without disturbing the more-recently-relevant keys.
        const first = seen.values().next().value
        if (first !== undefined) {
          seen.delete(first)
        }
      }
    }
  }
}

// Why: key for the replay dedup guard. Uses notificationId when present, but
// disambiguates by seq so a legitimate live re-delivery of the same id at a
// NEW seq (content refresh, allowed by the existing behaviour) is NOT treated
// as a duplicate, while a replay re-returning the SAME id+seq already delivered
// live is suppressed. Replay events always carry a seq (the desktop assigns
// one), so the guard is effective on the reconnect path.
function seenKeyForEvent(event: NotificationEvent | DismissNotificationEvent): string | null {
  const id = event.notificationId
  if (id != null && event.notificationSeq != null) {
    return `id:${id}#${event.notificationSeq}`
  }
  if (id != null) {
    return `id:${id}`
  }
  if (event.notificationSeq != null) {
    return `seq:${event.notificationSeq}`
  }
  return null
}

// Evict the oldest SETTLED entries (never one mid-schedule) until within the cap.
// Map iteration is insertion order, so the first match is the oldest.
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
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return {
    granted: status === 'granted',
    status,
    canAskAgain
  }
}

// Why: permissions must be requested before scheduling any local notification.
// Read the OS state every time because users can change it in Settings while
// Orca remains alive in the background.
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
    // Why: desktop can send dismiss while iOS/Android is still scheduling the
    // matching local notification. Remember it so no stale banner survives.
    state.dismissAfterSchedule = true
    return
  }
  if (!state.identifier) {
    return
  }
  scheduledNotificationsByHostAndNotificationId.delete(storedKey)
  await Notifications.dismissNotificationAsync(state.identifier).catch(() => {})
}

// Why: each host connection gets its own notification subscription. When the
// connection drops, the unsubscribe function cleans up the streaming RPC.
// On reconnect the same subscribe stream is re-established by the RPC client;
// we use its `ready` event to trigger catch-up (#8129): fetch notifications
// dispatched while the socket was reaped, watermarked by the last seq we
// already delivered so the desktop never re-sends an already-pushed one.
// Returns an unsubscribe function.
export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  configureNotificationChannel()

  let subscriptionId: string | null = null
  let disposed = false
  // Highest seq delivered on the live stream or replay for this connection.
  // Persisted per-host so a cold app start still resumes from the right cut.
  let lastDeliveredSeq = 0
  // Why: per-connection dedup guard applied ONLY to the replay path
  // (fetchMissed), never the live stream. The desktop already guarantees the
  // replay cannot contain an event with seq <= lastDeliveredSeq (both live and
  // replay advance the same watermark), so live + replay never overlap there.
  // This set is defense-in-depth: if the desktop's bounded buffer evicted an
  // old entry and a reconnect re-fetches across a boundary, an id delivered in
  // the same connection isn't pushed twice. Bounded (RECENTLY_SEEN_CAP) so a
  // long-lived session can't grow without limit.
  const seenReplay = createSeenNotificationGuard()

  function deliverLive(
    type: 'notification' | 'dismiss',
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    if (event.notificationSeq != null && event.notificationSeq > lastDeliveredSeq) {
      lastDeliveredSeq = event.notificationSeq
      void saveLastSeenSeq(hostId, lastDeliveredSeq)
    }
    // Why (#8129 dedup): mark the event seen on EVERY delivery path (live AND
    // replay) so a replay that re-includes an id already pushed live in this
    // connection is dropped instead of double-pushed. fetchMissed also
    // pre-checks seenReplay, but without this the live path never populated it.
    const key = seenKeyForEvent(event)
    if (key) {
      seenReplay.add(key)
    }
    if (type === 'notification') {
      return showLocalNotification(event as NotificationEvent, hostId)
    }
    return dismissLocalNotification(event as DismissNotificationEvent, hostId)
  }

  // Why: on a reconnect `ready` the desktop has already dispatched whatever we
  // missed; ask for it from our persisted watermark. Because the desktop cuts
  // by seq > lastSeenSeq this is idempotent — we only ever get events we have
  // not delivered before. The seenReplay guard is a second layer so a replay
  // that somehow re-includes an id already delivered this connection is
  // dropped instead of double-pushed.
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

  // Why: lazily seed the watermark from durable storage on first use so we
  // don't block subscribe() on an AsyncStorage read. The first `ready` (cold
  // open) does NOT need catch-up — the live stream starts fresh; only
  // subsequent reconnect `ready` events fetch missed notifications.
  let watermarkLoaded = false
  void loadLastSeenSeq(hostId).then((seq) => {
    lastDeliveredSeq = seq
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
      // Why: first ready is the cold-open live stream — no catch-up needed.
      // Every later ready is a reconnect; fetch what we missed from the
      // watermark. Guard on watermarkLoaded so a fast reconnect doesn't
      // fetch from a stale 0 watermark (which would re-push everything).
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
    // Why: the client may already be closed when this cleanup runs (component
    // unmount races with disconnect). sendRequest rejects immediately on a
    // closed client — swallow it since server-side cleanup happens via
    // connection-close anyway.
    // Always drop the local stream first; readiness can race unmount and we
    // must not retain the callback while waiting for a subscription id.
    unsubscribeStream()
    if (subscriptionId) {
      unsubscribeServer(subscriptionId)
    }
  }
}
