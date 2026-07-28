import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import {
  adoptNotificationEpoch,
  clearWatermark,
  getHostNotificationSession,
  resetHostNotificationSessionsForTests,
  seedWatermarkFromStorage
} from './notification-reconnect-catchup'
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

// A storage whose reads can be held open, so a live event can be injected into the
// exact window a real cold open has: subscription up, persisted watermark not yet read.
const storage = new Map<string, string>()
let heldReads: (() => void)[] = []
let holdReads = false
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => {
      const read = (): string | null => storage.get(key) ?? null
      if (!holdReads) {
        return Promise.resolve(read())
      }
      return new Promise<string | null>((resolve) => {
        heldReads.push(() => resolve(read()))
      })
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key)
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

function releaseReads(): void {
  const pending = heldReads
  heldReads = []
  for (const resolve of pending) {
    resolve()
  }
}

function makeHostClient() {
  let onData: ((data: unknown) => void) | null = null
  const getMissedCalls: { lastSeenSeq: number; epoch?: string }[] = []
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
        getMissedCalls.push(params as { lastSeenSeq: number; epoch?: string })
        return { ok: true, result: { notifications: [] } } as never
      }
      return { ok: true, result: undefined } as never
    })
  }
  return {
    client: client as unknown as RpcClient,
    get onData() {
      return onData
    },
    getMissedCalls
  }
}

const WATERMARK_KEY = 'orca:mobileNotificationsWatermark:host-1'
const LEGACY_KEY = 'orca:mobileNotificationsLastSeq:host-1'

describe('#8591 watermark seeding races a cold open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    heldReads = []
    holdReads = false
    resetHostNotificationSessionsForTests()
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  })

  it('asks for catch-up from the persisted seq even if a live event lands first', async () => {
    // The window is real: app/index.tsx subscribes immediately, and the desktop's
    // 'ready' plus its first live fan-out can both beat an AsyncStorage read. If the
    // live seq is allowed to advance the watermark first, getMissedSince is asked to
    // start from it and the desktop cuts everything the device actually missed.
    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-a' }))
    holdReads = true
    const host = makeHostClient()

    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-a' })
    host.onData?.({
      type: 'notification',
      title: 'live-12',
      body: 'b',
      notificationId: 'agent:live',
      notificationSeq: 12,
      notificationEpoch: 'epoch-a'
    })
    await flushAsync()

    // Nothing may be decided while the read is outstanding.
    expect(host.getMissedCalls).toHaveLength(0)

    releaseReads()
    await flushAsync()

    expect(host.getMissedCalls).toEqual([{ lastSeenSeq: 5, epoch: 'epoch-a' }])
  })

  it('treats a zeroed-but-present watermark as a returning device, not a first pairing', async () => {
    // adoptNotificationEpoch persists {seq: 0, epoch} when it voids a watermark from a
    // dead counter. That record still proves this device has been subscribed here, so a
    // cold open after it must catch up — reading it as "never paired" drops the window.
    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 0, epoch: 'epoch-a' }))
    const host = makeHostClient()

    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-a' })
    await flushAsync()

    expect(host.getMissedCalls).toEqual([{ lastSeenSeq: 0, epoch: 'epoch-a' }])
  })

  it('does not catch up on a first-ever pairing', async () => {
    const host = makeHostClient()

    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-a' })
    await flushAsync()

    expect(host.getMissedCalls).toEqual([])
  })

  it('a seed landing after a live epoch is adopted cannot reinstate the dead watermark', async () => {
    // Ordering invariant on the exported pair, not a path subscribeToDesktopNotifications
    // can currently take — 'ready' awaits watermarkSeeded before adopting, so the seed
    // always resolves first today. Pinned anyway because the guard is load-bearing the
    // moment any caller adopts an epoch before seeding: applying a seq 40 from a counter
    // that no longer exists would let getMissedSince cut the new counter's 1..40, which
    // is the original #8591 loss re-entered through the seeding path.
    const session = getHostNotificationSession('host-1')
    adoptNotificationEpoch(session, 'host-1', 'epoch-new')
    await flushAsync()

    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 40, epoch: 'epoch-old' }))
    seedWatermarkFromStorage(session, 'host-1')
    await session.watermarkSeeded
    await flushAsync()

    expect(session.lastDeliveredEpoch).toBe('epoch-new')
    expect(session.lastDeliveredSeq).toBe(0)
  })

  it('clears the legacy seq key too, so an unpaired host cannot resurrect it', async () => {
    // loadWatermark falls back to the legacy key, so leaving it behind lets a re-paired
    // host read a pre-#8591 seq belonging to a counter lifetime that no longer exists.
    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 9, epoch: 'epoch-a' }))
    storage.set(LEGACY_KEY, '57')

    await clearWatermark('host-1')

    expect(vi.mocked(AsyncStorage.removeItem).mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([WATERMARK_KEY, LEGACY_KEY])
    )
    expect(storage.has(WATERMARK_KEY)).toBe(false)
    expect(storage.has(LEGACY_KEY)).toBe(false)
  })
})
