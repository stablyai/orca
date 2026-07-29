import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: 18 }
}))

// In-memory AsyncStorage so the persisted watermark survives across the
// subscribe/unsubscribe cycles this test exercises (the real device behaviour).
const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      storage.set(k, v)
    })
  }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn()
}))

function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
}

// Models mobile/app/index.tsx:497-537: a per-host client whose notification
// subscription is torn down on any non-'connected' state and re-created from
// scratch on the next 'connected'.
function makeHostClient() {
  let onData: ((data: unknown) => void) | null = null
  const getMissedCalls: { lastSeenSeq: number }[] = []
  const client = {
    subscribe: vi.fn((_m: string, _p: unknown, cb: (data: unknown) => void) => {
      onData = cb
      return vi.fn(() => {
        onData = null
      })
    }),
    getState: vi.fn(() => 'connected'),
    sendRequest: vi.fn(async (method: string, params: unknown = {}) => {
      if (method === 'notifications.getMissedSince') {
        getMissedCalls.push(params as { lastSeenSeq: number })
        return { ok: true, result: { notifications: missedQueue } } as never
      }
      return { ok: true, result: undefined } as never
    })
  }
  let missedQueue: unknown[] = []
  return {
    client: client as unknown as RpcClient,
    get onData() {
      return onData
    },
    getMissedCalls,
    setMissed(events: unknown[]) {
      missedQueue = events
    }
  }
}

describe('#8591 reconnect catch-up under the real app teardown lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    resetHostNotificationSessionsForTests()
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    vi.mocked(AsyncStorage.getItem).mockClear()
  })

  it('fetches missed notifications after a disconnect tears the subscription down', async () => {
    const host = makeHostClient()

    // ── Connected: cold open, one live notification delivered (desktop seq 7).
    const unsub = subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    host.onData?.({
      type: 'notification',
      title: 'live',
      body: 'b',
      notificationId: 'agent:live',
      notificationSeq: 7
    })
    await flushAsync()

    // ── Socket drops. app/index.tsx wireUp() calls unsubNotif() on the
    // non-'connected' state, destroying the subscribeToDesktopNotifications
    // closure (and with it reconnectReadyCount / lastDeliveredSeq).
    unsub()
    await flushAsync()

    // ── While disconnected the desktop dispatched seq 8 and 9.
    host.setMissed([
      {
        type: 'notification',
        title: 'missed-8',
        body: 'b',
        notificationId: 'agent:m8',
        notificationSeq: 8
      },
      {
        type: 'notification',
        title: 'missed-9',
        body: 'b',
        notificationId: 'agent:m9',
        notificationSeq: 9
      }
    ])

    // ── Reconnected: app re-subscribes with a FRESH closure.
    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-2' })
    await flushAsync()

    // The user must be told about seq 8 and 9. Nothing else can deliver them:
    // the desktop only fans out live, so this catch-up is the only path.
    expect(host.getMissedCalls).toHaveLength(1)
    expect(host.getMissedCalls[0]).toEqual({ lastSeenSeq: 7 })
    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((c) => (c[0] as { content: { title: string } }).content.title)
    expect(titles).toContain('missed-8')
    expect(titles).toContain('missed-9')
  })

  it('does not re-push a live notification the catch-up replays after a teardown', async () => {
    // Why: the seen-set lives on the host session precisely so it survives the teardown.
    // getMissedSince cuts by seq > lastSeenSeq, but a notification delivered live in the
    // brief window before the drop is still inside the desktop's retained buffer, so the
    // reconnect fetch returns it again. Only the session-scoped seen-set stops a duplicate
    // banner for something the user was already shown.
    const host = makeHostClient()

    const unsub = subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    host.onData?.({
      type: 'notification',
      title: 'live-7',
      body: 'b',
      notificationId: 'agent:seven',
      notificationSeq: 7
    })
    await flushAsync()

    unsub()
    await flushAsync()

    // The desktop replays seq 7 alongside the genuinely-missed seq 8.
    host.setMissed([
      {
        type: 'notification',
        title: 'live-7',
        body: 'b',
        notificationId: 'agent:seven',
        notificationSeq: 7
      },
      {
        type: 'notification',
        title: 'missed-8',
        body: 'b',
        notificationId: 'agent:m8',
        notificationSeq: 8
      }
    ])

    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-2' })
    await flushAsync()

    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((c) => (c[0] as { content: { title: string } }).content.title)
    expect(titles.filter((title) => title === 'live-7')).toHaveLength(1)
    expect(titles).toContain('missed-8')
  })
})
