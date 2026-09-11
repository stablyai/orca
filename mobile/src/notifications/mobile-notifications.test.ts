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
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'

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
  // Why (#8591): the reconnect watermark/seen-set now live per host at module
  // scope so they survive the app's unsubscribe-on-disconnect. Reset between
  // tests so each case starts from a genuine cold open.
  resetHostNotificationSessionsForTests()
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

  // Why the macrotask and not N microtask ticks (#8591): deliveries now run through
  // the per-host serialization queue, so a delivery is several more `await` hops deep
  // than it used to be and a fixed tick count silently under-drains. Yielding to the
  // macrotask queue drains whatever depth the chain happens to have.
  function flushAsync(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
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

  it('voids a persisted watermark whose epoch predates a desktop restart', async () => {
    // #8591: the desktop's seq counter restarts at 0 each launch while this watermark
    // is persisted. Reconnecting to a restarted desktop with seq 57 would make
    // `57 >= 2` true and silently kill catch-up. The epoch on 'ready' is what tells
    // the client the counter changed, so the stale watermark must be dropped.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) =>
      key.startsWith('orca:mobileNotificationsWatermark:')
        ? JSON.stringify({ seq: 57, epoch: 'epoch-before-restart' })
        : null
    )

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    // Cold open under the OLD desktop process, so the watermark loads as 57.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-before-restart' })
    await flushAsync()
    await flushAsync()

    // Desktop restarts: new epoch, counter back near 0.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-after-restart' })
    await flushAsync()
    await flushAsync()

    const missedCalls = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.filter((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    // The cold open catches up from its stored watermark against the SAME counter —
    // 57 is meaningful there, so it is the correct cut (#8591 second pass).
    expect(missedCalls[0]?.[1]).toEqual({ lastSeenSeq: 57, epoch: 'epoch-before-restart' })
    // After the restart the watermark is reset to 0 and tagged with the live epoch —
    // not the stale 57, which would make `57 >= 2` true and kill catch-up silently.
    expect(missedCalls.at(-1)?.[1]).toEqual({ lastSeenSeq: 0, epoch: 'epoch-after-restart' })
  })

  it('refuses to seed a stored watermark that lost the race to a newer live epoch', async () => {
    // The seed read is deliberately not awaited (so subscribe doesn't block on
    // AsyncStorage), which means it can land AFTER 'ready' already adopted the live
    // epoch. If it seeds unconditionally it reinstates the exact stale cut #8591 is
    // about — the reset having already happened doesn't help, because the seed runs
    // last and wins. Only a stored epoch matching the live one may seed.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')

    // Hold the storage read open so 'ready' is guaranteed to be processed first.
    let releaseStorage: () => void = () => {}
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve
    })
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      await storageGate
      return key.startsWith('orca:mobileNotificationsWatermark:')
        ? JSON.stringify({ seq: 57, epoch: 'epoch-before-restart' })
        : null
    })

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    // Live epoch adopted while the stored one is still in flight.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-after-restart' })
    await flushAsync()

    releaseStorage()
    await flushAsync()

    sub.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-after-restart' })
    await flushAsync()
    await flushAsync()

    const missedCall = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.find((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    expect(missedCall?.[1]).toEqual({ lastSeenSeq: 0, epoch: 'epoch-after-restart' })
  })

  it('keeps the persisted watermark when the desktop epoch is unchanged', async () => {
    // The reset must be narrow: a plain socket reap with the same desktop process
    // still has to send the real watermark, or every reconnect re-pushes the buffer.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-1')
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) =>
      key.startsWith('orca:mobileNotificationsWatermark:')
        ? JSON.stringify({ seq: 57, epoch: 'epoch-stable' })
        : null
    )

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-stable' })
    await flushAsync()
    await flushAsync()
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-stable' })
    await flushAsync()
    await flushAsync()

    const missedCall = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.find((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    expect(missedCall?.[1]).toEqual({ lastSeenSeq: 57, epoch: 'epoch-stable' })
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
      'orca:mobileNotificationsWatermark:host-1',
      JSON.stringify({ seq: 5, epoch: null })
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
      'orca:mobileNotificationsWatermark:host-1',
      JSON.stringify({ seq: 8, epoch: null })
    )

    // Second reconnect resumes from the advanced watermark, not 0.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1' })
    await flushAsync()
    const missedCalls = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.filter((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    expect(missedCalls.at(-1)?.[1]).toEqual({ lastSeenSeq: 8 })
  })

  it('replays a terminal bell at a seq the previous desktop counter already used', async () => {
    // Round-1 review finding: seen-keys are seq-derived, and terminal bells carry no
    // notificationId (they key on `seq:N` alone). Epoch A delivers a bell at seq 1;
    // after a restart, epoch B's first bell is ALSO seq 1. The catch-up path is the
    // one that consults the seen-set, so without clearing it on epoch change the
    // replayed post-restart bell is mistaken for a duplicate and silently skipped —
    // #8591's silent loss again, now one notification at a time.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')

    const sub = makeClient()
    // Catch-up returns epoch B's first bell — same seq 1 the old counter used.
    sub.client.sendRequest = vi.fn(async (method: string) => {
      if (method === 'notifications.getMissedSince') {
        return {
          ok: true,
          result: {
            epoch: 'epoch-B',
            notifications: [{ type: 'notification', title: 'bell', body: 'B', notificationSeq: 1 }]
          }
        } as never
      }
      return { ok: true, result: undefined } as never
    })

    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-A' })
    await flushAsync()
    // A live bell under epoch A — no notificationId, so its seen-key is `seq:1`.
    sub.onData?.({ type: 'notification', title: 'bell', body: 'A', notificationSeq: 1 })
    await flushAsync()
    expect(vi.mocked(Notifications.scheduleNotificationAsync).mock.calls.length).toBe(1)

    // Desktop restarts; reconnect triggers catch-up against the fresh counter.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-B' })
    await flushAsync()
    await flushAsync()

    // The post-restart bell must reach the user, not be swallowed as a stale `seq:1`.
    expect(vi.mocked(Notifications.scheduleNotificationAsync).mock.calls.length).toBe(2)
  })

  it('does not trust a legacy epoch-less watermark against a live counter', async () => {
    // Round-1 review finding: pre-upgrade installs stored a bare seq with no epoch.
    // Seeding it and then treating the first observed epoch as "nothing changed"
    // leaves 57 cutting a counter it was never measured against — #8591 reached
    // through the upgrade path. An unprovenanced seq may not survive epoch adoption.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')
    // Only the LEGACY key exists — exactly what an upgrading install has on disk.
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) =>
      key.startsWith('orca:mobileNotificationsLastSeq:') ? '57' : null
    )

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    // Seed lands FIRST (no epoch known yet), so 57 is provisionally adopted...
    await flushAsync()
    await flushAsync()
    // ...then the live epoch arrives for the first time.
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-live' })
    await flushAsync()
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-live' })
    await flushAsync()
    await flushAsync()

    const missedCall = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.find((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    // Must not be 57: that seq was never shown to belong to this counter.
    expect(missedCall?.[1]).toEqual({ lastSeenSeq: 0, epoch: 'epoch-live' })
  })

  it('catches up on the FIRST connection after an upgrade, without a second ready', async () => {
    // Round-2 review finding: catch-up hung off `connectedBefore`, which is false on
    // the first 'ready' of a process. So a cold app open — post-upgrade, or after the
    // OS evicted the app — adopted the epoch but never replayed. Everything between
    // the stored watermark and the next live seq was then lost permanently, because
    // the first live event advances the watermark past the gap.
    //
    // The earlier migration test masked this by emitting a SECOND 'ready'. This one
    // emits exactly one, which is what a real cold open does.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) =>
      key.startsWith('orca:mobileNotificationsWatermark:')
        ? JSON.stringify({ seq: 57, epoch: 'epoch-live' })
        : null
    )

    const sub = makeClient()
    vi.mocked(sub.client.sendRequest).mockImplementation(async (method: string) =>
      method === 'notifications.getMissedSince'
        ? {
            ok: true,
            result: {
              epoch: 'epoch-live',
              notifications: [
                {
                  type: 'notification',
                  notificationId: 'missed-58',
                  notificationSeq: 58,
                  notificationEpoch: 'epoch-live',
                  title: 'while the app was closed',
                  body: 'b'
                }
              ]
            }
          }
        : { ok: true, result: {} }
    )
    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-live' })
    await flushAsync()
    await flushAsync()
    await flushAsync()

    const missedCall = vi
      .mocked(sub.client.sendRequest)
      .mock.calls.find((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    // The single 'ready' must replay from the stored watermark, not skip it.
    expect(missedCall?.[1]).toEqual({ lastSeenSeq: 57, epoch: 'epoch-live' })
    // And the missed notification must actually reach the user.
    expect(vi.mocked(Notifications.scheduleNotificationAsync).mock.calls.length).toBe(1)
  })

  it('does not replay the desktop buffer at a first-ever pairing', async () => {
    // The other side of the finding above: with nothing stored, this device has never
    // delivered for this host. Catching up would push the whole retained buffer at a
    // user who was never subscribed for any of it.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-live' })
    await flushAsync()
    await flushAsync()
    await flushAsync()

    expect(
      vi
        .mocked(sub.client.sendRequest)
        .mock.calls.filter((c: unknown[]) => c[0] === 'notifications.getMissedSince')
    ).toHaveLength(0)
  })

  it('persists seq and epoch as one value so a crash cannot split the pair', async () => {
    // Round-1 review finding: written as two keys, a process death between the writes
    // leaves epoch-B beside seq-57-from-A. That pair looks internally valid on the
    // next launch and is therefore trusted — silently cutting B's first 57 events.
    // One key means the pair is always written whole or not at all.
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('s')

    const sub = makeClient()
    subscribeToDesktopNotifications(sub.client, 'host-1')
    sub.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-A' })
    await flushAsync()
    sub.onData?.({
      type: 'notification',
      title: 't',
      body: 'b',
      notificationId: 'agent:x',
      notificationSeq: 9
    })
    await flushAsync()

    // Every watermark write is a single key carrying both halves together.
    const watermarkWrites = AsyncStorageMock.setItem.mock.calls.filter((c: unknown[]) =>
      String(c[0]).startsWith('orca:mobileNotifications')
    )
    expect(watermarkWrites.length).toBeGreaterThan(0)
    for (const [key, value] of watermarkWrites) {
      expect(key).toBe('orca:mobileNotificationsWatermark:host-1')
      expect(JSON.parse(String(value))).toHaveProperty('epoch')
      expect(JSON.parse(String(value))).toHaveProperty('seq')
    }
    expect(JSON.parse(String(watermarkWrites.at(-1)?.[1]))).toEqual({
      seq: 9,
      epoch: 'epoch-A'
    })
  })
})
