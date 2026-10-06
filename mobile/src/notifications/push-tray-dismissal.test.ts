import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { dismissPresentedPushNotification } from './push-tray-dismissal'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) }
}))

vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

function presented(identifier: string, data: unknown): unknown {
  return { request: { identifier, content: { data } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
})

describe('dismissPresentedPushNotification', () => {
  it('dismisses only the tray entries whose push payload carries the same notification id', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('tray-1', {
        orca: { hostFingerprint: 'fp0123456789abcd', notificationId: 'agent:one' }
      }),
      presented('tray-2', {
        orca: { hostFingerprint: 'fp0123456789abcd', notificationId: 'agent:two' }
      }),
      presented('other-host', { hostFingerprint: 'another-host', notificationId: 'agent:one' }),
      // Flat FCM shape for the same notification, presented on Android.
      presented('tray-3', { hostFingerprint: 'fp0123456789abcd', notificationId: 'agent:one' })
    ] as never)

    await dismissPresentedPushNotification('agent:one', 'fp0123456789abcd')

    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)).toEqual([
      'tray-1',
      'tray-3'
    ])
  })

  it('ignores notifications without a gateway identity', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('tray-1', { hostId: 'host-1', notificationId: 'agent:one' })
    ] as never)

    await dismissPresentedPushNotification('agent:one', 'fp0123456789abcd')

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  })

  it('reports tray query failures to the caller', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValue(
      new Error('unavailable')
    )

    await expect(dismissPresentedPushNotification('agent:one', 'fp0123456789abcd')).rejects.toThrow(
      'unavailable'
    )
  })
})

it('a delayed dismissal preserves newer alerts, other epochs, and other hosts', async () => {
  const base = { hostFingerprint: 'host-a', notificationId: 'note', notificationEpoch: 'epoch-a' }
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    presented('older', { ...base, notificationSeq: 1 }),
    presented('equal', { ...base, notificationSeq: 2 }),
    presented('newer', { ...base, notificationSeq: 3 }),
    presented('restarted', { ...base, notificationSeq: 1, notificationEpoch: 'epoch-b' }),
    presented('other-host', { ...base, notificationSeq: 1, hostFingerprint: 'host-b' }),
    presented('legacy', base)
  ] as never)
  await dismissPresentedPushNotification('note', 'host-a', {
    notificationEpoch: 'epoch-a',
    notificationSeq: 2
  })
  expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)).toEqual([
    'older',
    'equal'
  ])
})

it.each([undefined, {}, { notificationEpoch: 'epoch' }, { notificationSeq: 2 }])(
  'an incomplete dismissal fence %j removes only unversioned entries',
  async (fence) => {
    const base = { hostFingerprint: 'host-a', notificationId: 'note' }
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('unversioned', base),
      presented('versioned', { ...base, notificationEpoch: 'epoch', notificationSeq: 2 }),
      presented('epoch-only', { ...base, notificationEpoch: 'epoch' }),
      presented('sequence-only', { ...base, notificationSeq: 2 })
    ] as never)
    await dismissPresentedPushNotification('note', 'host-a', fence)
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('unversioned')
  }
)
