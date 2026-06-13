import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
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
  Platform: { OS: 'ios' }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn()
}))

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
})
