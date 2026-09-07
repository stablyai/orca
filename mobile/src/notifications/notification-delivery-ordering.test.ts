import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'
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

const WATERMARK_KEY = 'orca:mobileNotificationsWatermark:host-1'
const storage = new Map<string, string>()
let getItemImpl: (key: string) => Promise<string | null> = async (key) => storage.get(key) ?? null

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => getItemImpl(key)),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
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

function persistedSeq(): number {
  return (JSON.parse(storage.get(WATERMARK_KEY) ?? '{}') as { seq?: number }).seq ?? 0
}

describe('#8591 per-host delivery ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    getItemImpl = async (key) => storage.get(key) ?? null
    resetHostNotificationSessionsForTests()
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  })

  it('never persists a watermark past a notification the catch-up has not shown', async () => {
    // The watermark is a promise that everything up to that seq reached the user.
    // If a live seq 11 is processed while catch-up is still showing seq 6, it
    // persists 11 — and a process death before 7 is shown loses 7 forever, because
    // the next launch asks the desktop for seq > 11. That is the original #8591
    // loss re-entered through concurrency rather than through a restarted counter.
    let releaseFirstShow!: () => void
    const firstShowBlocked = new Promise<void>((resolve) => {
      releaseFirstShow = resolve
    })
    let shown = 0
    vi.mocked(Notifications.scheduleNotificationAsync).mockImplementation(async () => {
      shown += 1
      if (shown === 1) {
        await firstShowBlocked
      }
      return 'sched-1'
    })

    let onData: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_m: string, _p: unknown, cb: (data: unknown) => void) => {
        onData = cb
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'notifications.getMissedSince') {
          return {
            ok: true,
            result: {
              notifications: [
                {
                  type: 'notification',
                  title: 'm6',
                  body: 'b',
                  notificationId: 'a:6',
                  notificationSeq: 6
                },
                {
                  type: 'notification',
                  title: 'm7',
                  body: 'b',
                  notificationId: 'a:7',
                  notificationSeq: 7
                }
              ]
            }
          } as never
        }
        return { ok: true, result: undefined } as never
      })
    } as unknown as RpcClient

    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-1' }))
    subscribeToDesktopNotifications(client, 'host-1')
    onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()

    // Live seq 11 arrives while the replay is wedged on seq 6.
    onData?.({
      type: 'notification',
      title: 'live-11',
      body: 'b',
      notificationId: 'a:11',
      notificationSeq: 11
    })
    await flushAsync()

    expect(persistedSeq()).toBeLessThan(6)

    releaseFirstShow()
    await flushAsync()

    // Once the chain drains, everything is shown and the watermark catches up.
    expect(persistedSeq()).toBe(11)
    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((call) => (call[0] as { content: { title: string } }).content.title)
    expect(titles).toEqual(['m6', 'm7', 'live-11'])
  })

  it('shows one banner when a replay and a live event carry the same notification id', async () => {
    // Serializing deliveries removed the overlap the old dedup relied on: the
    // replay's show now COMPLETES before the live duplicate starts, so nothing is
    // pending for it to observe and the user gets the same notification twice.
    let releaseFirstShow!: () => void
    const firstShowBlocked = new Promise<void>((resolve) => {
      releaseFirstShow = resolve
    })
    let shown = 0
    vi.mocked(Notifications.scheduleNotificationAsync).mockImplementation(async () => {
      shown += 1
      if (shown === 1) {
        await firstShowBlocked
      }
      return `sched-${shown}`
    })

    let onData: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_m: string, _p: unknown, cb: (data: unknown) => void) => {
        onData = cb
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'notifications.getMissedSince') {
          return {
            ok: true,
            result: {
              notifications: [
                {
                  type: 'notification',
                  title: 'dup',
                  body: 'b',
                  notificationId: 'agent:dup',
                  notificationSeq: 6
                }
              ]
            }
          } as never
        }
        return { ok: true, result: undefined } as never
      })
    } as unknown as RpcClient

    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-1' }))
    subscribeToDesktopNotifications(client, 'host-1')
    onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()

    // Same id arrives live while the replay's show is still blocked. A different
    // seq, so the seen-set does not catch it — only the queued-show claim does.
    onData?.({
      type: 'notification',
      title: 'dup',
      body: 'b',
      notificationId: 'agent:dup',
      notificationSeq: 7
    })
    await flushAsync()

    releaseFirstShow()
    await flushAsync()

    expect(vi.mocked(Notifications.scheduleNotificationAsync)).toHaveBeenCalledTimes(1)
  })

  it('still delivers when the persisted watermark read never resolves', async () => {
    // Every delivery awaits the seed, so a wedged AsyncStorage read would disable
    // this host's notifications for the whole app lifetime — silently.
    getItemImpl = () => new Promise<string | null>(() => {})

    let onData: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_m: string, _p: unknown, cb: (data: unknown) => void) => {
        onData = cb
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn(async () => ({ ok: true, result: undefined }) as never)
    } as unknown as RpcClient

    vi.useFakeTimers()
    try {
      subscribeToDesktopNotifications(client, 'host-1')
      onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
      onData?.({
        type: 'notification',
        title: 'live-1',
        body: 'b',
        notificationId: 'a:1',
        notificationSeq: 1
      })
      await vi.advanceTimersByTimeAsync(3100)
    } finally {
      vi.useRealTimers()
    }

    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((call) => (call[0] as { content: { title: string } }).content.title)
    expect(titles).toContain('live-1')
  })
})
