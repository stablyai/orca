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

  function createEventCapturingClient(): { client: RpcClient; emit: (data: unknown) => void } {
    let onEvent: ((data: unknown) => void) | null = null
    const client = {
      subscribe: vi.fn((_method, _params, callback: (data: unknown) => void) => {
        onEvent = callback
        return vi.fn()
      }),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient
    return { client, emit: (data) => onEvent?.(data) }
  }

  function grantNotificationPermissions(): void {
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
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
    grantNotificationPermissions()
    vi.mocked(Notifications.scheduleNotificationAsync)
      .mockResolvedValueOnce('scheduled-1')
      .mockResolvedValueOnce('scheduled-2')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    const { client, emit: onEvent } = createEventCapturingClient()

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

  it('drops a concurrent duplicate event for the same notification id', async () => {
    grantNotificationPermissions()
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-dup')
    const { client, emit: onEvent } = createEventCapturingClient()

    subscribeToDesktopNotifications(client, 'host-2')
    const event = {
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:dup'
    }
    // Same event delivered twice in the same tick (transport-level double
    // delivery) must surface a single local notification.
    onEvent?.(event)
    onEvent?.(event)
    await flushAsync()

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1)
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  })

  it('dismisses a notification whose dismiss event arrives while the show is in flight', async () => {
    grantNotificationPermissions()
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('scheduled-race')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    const { client, emit: onEvent } = createEventCapturingClient()

    subscribeToDesktopNotifications(client, 'host-3')
    // Desktop auto-dismisses on acknowledgement, so the dismiss can land in
    // the same tick as the notification — before the identifier is stored.
    onEvent?.({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Done',
      body: 'Finished.',
      notificationId: 'agent:race'
    })
    onEvent?.({ type: 'dismiss', notificationId: 'agent:race' })
    await flushAsync()

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1)
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('scheduled-race')
  })

  it('treats unknown dismiss events as no-ops', async () => {
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
    const { client, emit: onEvent } = createEventCapturingClient()

    subscribeToDesktopNotifications(client, 'host-unknown')
    onEvent?.({ type: 'dismiss', notificationId: 'agent:missing' })
    await flushAsync()

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  })
})
