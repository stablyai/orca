import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import {
  getNotificationPermissionState,
  setScheduledNotificationsMaxForTests,
  subscribeToDesktopNotifications
} from './mobile-notifications'
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

// Why: mobile-notifications now persists the catch-up watermark to
// AsyncStorage. The package isn't resolvable in the node test env (other
// mobile tests mock it the same way), so we provide a no-op mock.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined)
  }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn()
}))

beforeEach(() => {
  Object.assign(Platform, { OS: 'ios', Version: 18 })
})

describe('getNotificationPermissionState', () => {
  it.each([
    { os: 'android', version: 32, expected: false },
    { os: 'android', version: 33, expected: true },
    { os: 'ios', version: 18, expected: true }
  ])(
    'reports whether a granted $os $version authorization reflects user choice',
    async ({ os, version, expected }) => {
      Object.assign(Platform, { OS: os, Version: version })
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        status: 'granted',
        canAskAgain: true
      } as never)

      await expect(getNotificationPermissionState()).resolves.toMatchObject({
        granted: true,
        authorizationReflectsUserChoice: expected
      })
    }
  )
})

describe('subscribeToDesktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function flushAsync(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
  }

  function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((next) => {
      resolve = next
    })
    return { promise, resolve }
  }

  it('drops the local stream when disposed before the desktop returns ready', () => {
    const unsubscribeStream = vi.fn()
    const client = {
      subscribe: vi.fn(() => unsubscribeStream),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    const unsubscribe = subscribeToDesktopNotifications(client, 'host-1')
    unsubscribe()

    expect(unsubscribeStream).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('stores scheduled notification identifiers, replaces duplicates, and dismisses by id', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync)
      .mockResolvedValueOnce('scheduled-1')
      .mockResolvedValueOnce('scheduled-2')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    subscribeToDesktopNotifications(client, 'host-1')
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      worktreeId: 'repo::/tmp/worktree',
      notificationId: 'agent:one'
    })
    await flushAsync()
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done again',
      body: 'Finished again.',
      notificationId: 'agent:one'
    })
    await flushAsync()
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
    onEvent?.({ type: 'dismiss', notificationId: 'agent:one' })
    await flushAsync()

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
    expect(Notifications.scheduleNotificationAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: expect.objectContaining({
          data: expect.objectContaining({
            hostId: 'host-1',
            notificationId: 'agent:one',
            worktreeId: 'repo::/tmp/worktree'
          })
        })
      })
    )
    expect(Notifications.dismissNotificationAsync).toHaveBeenNthCalledWith(1, 'scheduled-1')
    expect(Notifications.dismissNotificationAsync).toHaveBeenNthCalledWith(2, 'scheduled-2')
  })

  it('dedupes concurrent notification events with the same desktop notification id', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    subscribeToDesktopNotifications(client, 'host-concurrent')
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:concurrent'
    })
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:concurrent'
    })
    await flushAsync()

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1)
  })

  it('dismisses a notification when dismiss arrives while scheduling is pending', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    let resolveSchedule!: (identifier: string) => void
    vi.mocked(Notifications.scheduleNotificationAsync).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSchedule = resolve
        })
    )
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    subscribeToDesktopNotifications(client, 'host-dismiss-race')
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:pending'
    })
    await flushAsync()
    onEvent?.({ type: 'dismiss', notificationId: 'agent:pending' })
    resolveSchedule('scheduled-pending')
    await flushAsync()

    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('scheduled-pending')
  })

  it('does not carry a failed pending dismiss into a future schedule', async () => {
    const secondEnabled = makeDeferred<boolean>()
    vi.mocked(loadPushNotificationsEnabled)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(secondEnabled.promise)
      .mockResolvedValueOnce(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync)
      .mockResolvedValueOnce('scheduled-1')
      .mockResolvedValueOnce('scheduled-2')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    subscribeToDesktopNotifications(client, 'host-dismiss-failed-replacement')
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:stale-dismiss'
    })
    await flushAsync()
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done again',
      body: 'Finished again.',
      notificationId: 'agent:stale-dismiss'
    })
    await flushAsync()
    onEvent?.({ type: 'dismiss', notificationId: 'agent:stale-dismiss' })
    secondEnabled.resolve(false)
    await flushAsync()

    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done later',
      body: 'Finished later.',
      notificationId: 'agent:stale-dismiss'
    })
    await flushAsync()

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2)
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledTimes(1)
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('scheduled-1')
  })

  it('treats unknown dismiss events as no-ops', async () => {
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    subscribeToDesktopNotifications(client, 'host-unknown')
    onEvent?.({ type: 'dismiss', notificationId: 'agent:missing' })
    await flushAsync()

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  })

  // Why: notificationId is unique per completion, so the map grew unbounded when
  // the desktop never sent a dismiss (the remote-mobile case). It is now capped.
  it('evicts the oldest scheduled entry once the cap is exceeded', async () => {
    setScheduledNotificationsMaxForTests(1)
    try {
      vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        status: 'granted',
        canAskAgain: true
      } as never)
      vi.mocked(Notifications.scheduleNotificationAsync)
        .mockResolvedValueOnce('scheduled-old')
        .mockResolvedValueOnce('scheduled-new')
      vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
      let onEvent: ((data: unknown) => void) | null = null
      const client = {
        subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
          onEvent = callback
          return vi.fn()
        }),
        getState: vi.fn(() => 'connected'),
        sendRequest: vi.fn()
      } as unknown as RpcClient

      subscribeToDesktopNotifications(client, 'host-1')
      onEvent?.({ type: 'notification', title: 't', body: 'b', notificationId: 'agent:old' })
      await flushAsync()
      onEvent?.({ type: 'notification', title: 't', body: 'b', notificationId: 'agent:new' })
      await flushAsync()

      // The older entry was evicted by the cap: dismissing it is a no-op...
      onEvent?.({ type: 'dismiss', notificationId: 'agent:old' })
      await flushAsync()
      expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalledWith('scheduled-old')

      // ...while the most-recent entry is retained and still dismissable.
      onEvent?.({ type: 'dismiss', notificationId: 'agent:new' })
      await flushAsync()
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('scheduled-new')
    } finally {
      setScheduledNotificationsMaxForTests()
    }
  })
})

// Why: #8129 catch-up. On a reconnect the live stream re-emits `ready`; the
// client must fetch missed notifications from its watermark and push exactly
// the ones it had not yet delivered — never re-pushing an already-delivered id.
describe('subscribeToDesktopNotifications — reconnect catch-up', () => {
  const AsyncStorageMock = vi.mocked(AsyncStorage)

  beforeEach(() => {
    vi.clearAllMocks()
    AsyncStorageMock.getItem.mockResolvedValue(null)
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  })

  function flushAsync(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }

  function makeClient() {
    let onData: ((data: unknown) => void) | null = null
    const sentRequests: { method: string; params: unknown }[] = []
    const client = {
      subscribe: vi.fn((_method: string, _params: unknown, cb: (data: unknown) => void) => {
        onData = cb
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn(
        async (method: string, _params: unknown = {}) =>
          ({
            ok: true,
            result: method === 'notifications.getMissedSince' ? { notifications: [] } : undefined
          }) as never
      )
    }
    // Why: onData is captured live via a getter (not destructured) because the
    // subscribe mock assigns it asynchronously as a side effect of
    // subscribeToDesktopNotifications calling client.subscribe.
    return {
      client: client as unknown as RpcClient,
      get onData() {
        return onData
      },
      sentRequests
    }
  }

  it('does not fetch missed notifications on the first (cold-open) ready', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    // First ready = cold open.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()

    expect(sub.client.sendRequest).not.toHaveBeenCalledWith(
      'notifications.getMissedSince',
      expect.anything()
    )
  })

  it('fetches only notifications after the delivered watermark (idempotent catch-up)', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')

    const sub = makeClient()
    // The desktop honours the watermark: only seq 10 (agent:missed) is returned
    // because seq 11 (agent:dup) was already delivered on the live stream and
    // advanced lastDeliveredSeq to 11. So the replay never re-includes it.
    sub.client.sendRequest = vi.fn(async (method: string) => {
      if (method === 'notifications.getMissedSince') {
        return {
          ok: true,
          result: {
            notifications: [
              {
                type: 'notification',
                title: 'missed',
                body: 'b',
                notificationId: 'agent:missed',
                notificationSeq: 10
              }
            ]
          }
        } as never
      }
      return { ok: true, result: undefined } as never
    })

    subscribeToDesktopNotifications(sub.client, 'host-1')
    // First ready = cold open (no fetch).
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    // Live stream already delivered agent:dup (seq 11) before reap.
    sub.onData?.({
      type: 'notification',
      title: 'dup',
      body: 'b',
      notificationId: 'agent:dup',
      notificationSeq: 11
    })
    await flushAsync()
    // Reconnect ready → fetchMissed sends the watermark (11).
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    await flushAsync()

    // The watermark passed to getMissedSince is the delivered seq.
    const missedCall = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.find((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    expect(missedCall?.[1]).toEqual({ lastSeenSeq: 11 })
    // Only agent:missed was pushed; agent:dup appears exactly once (live only).
    const scheduledIds = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map(
        (call) =>
          (call[0] as { content: { data: { notificationId: string } } }).content.data.notificationId
      )
    expect(scheduledIds).toEqual(['agent:dup', 'agent:missed'])
    expect(scheduledIds.filter((id) => id === 'agent:dup')).toHaveLength(1)
  })

  it('drops an already-seen id if a replay re-includes it (defense-in-depth)', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')

    const sub = makeClient()
    // Simulate the bounded-buffer edge: the desktop returns seq 11 again
    // (already delivered live) alongside a new seq 12.
    sub.client.sendRequest = vi.fn(async (method: string) => {
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
                notificationSeq: 11
              },
              {
                type: 'notification',
                title: 'new',
                body: 'b',
                notificationId: 'agent:new',
                notificationSeq: 12
              }
            ]
          }
        } as never
      }
      return { ok: true, result: undefined } as never
    })

    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    // Live stream delivered agent:dup (seq 11) before reap.
    sub.onData?.({
      type: 'notification',
      title: 'dup',
      body: 'b',
      notificationId: 'agent:dup',
      notificationSeq: 11
    })
    await flushAsync()
    // Reconnect replay re-includes seq 11 (must be dropped) + new seq 12.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    await flushAsync()

    const scheduledIds = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map(
        (call) =>
          (call[0] as { content: { data: { notificationId: string } } }).content.data.notificationId
      )
    expect(scheduledIds).toEqual(['agent:dup', 'agent:new'])
    expect(scheduledIds.filter((id) => id === 'agent:dup')).toHaveLength(1)
  })

  it('persists the highest delivered seq so a later reconnect resumes from it', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    // Live stream delivers seq 5.
    sub.onData?.({
      type: 'notification',
      title: 't',
      body: 'b',
      notificationId: 'agent:live',
      notificationSeq: 5
    })
    await flushAsync()

    expect(AsyncStorageMock.setItem).toHaveBeenCalledWith(
      'orca:mobileNotificationsLastSeq:host-1',
      '5'
    )
  })

  // Why: a replay-ONLY delivery (nothing arrived live first) must still advance
  // and persist the watermark. This is the exact case the seq/notificationSeq
  // field mismatch broke — the desktop replay path returns `notificationSeq`
  // (matching the live fan-out), so the client watermark moves and the next
  // reconnect resumes from it instead of re-fetching from 0.
  it('advances + persists the watermark from a replay-only delivery (#8129 field-mismatch regression)', async () => {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')

    const sub = makeClient()
    // Desktop replay returns events keyed by notificationSeq (the fixed shape).
    sub.client.sendRequest = vi.fn(async (method: string) => {
      if (method === 'notifications.getMissedSince') {
        return {
          ok: true,
          result: {
            notifications: [
              {
                type: 'notification',
                title: 'missed',
                body: 'b',
                notificationId: 'agent:missed',
                notificationSeq: 8
              }
            ]
          }
        } as never
      }
      return { ok: true, result: undefined } as never
    })

    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    // First reconnect → replay delivers seq 8 (no prior live delivery).
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    await flushAsync()

    // Watermark advanced to the replayed seq and was persisted.
    expect(AsyncStorageMock.setItem).toHaveBeenCalledWith(
      'orca:mobileNotificationsLastSeq:host-1',
      '8'
    )

    // Second reconnect resumes from the advanced watermark, not 0.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    const missedCalls = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.filter((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    expect(missedCalls.at(-1)?.[1]).toEqual({ lastSeenSeq: 8 })
  })
})
