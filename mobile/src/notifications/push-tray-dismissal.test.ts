import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { dismissPresentedPushNotification } from './push-tray-dismissal'

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
      // Flat FCM shape for the same notification, presented on Android.
      presented('tray-3', { hostFingerprint: 'fp0123456789abcd', notificationId: 'agent:one' })
    ] as never)

    await dismissPresentedPushNotification('agent:one')

    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)).toEqual([
      'tray-1',
      'tray-3'
    ])
  })

  it('ignores locally scheduled notifications, which the local registry already owns', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('tray-1', { hostId: 'host-1', notificationId: 'agent:one' })
    ] as never)

    await dismissPresentedPushNotification('agent:one')

    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  })

  it('stays silent on a native shell that cannot query the tray', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValue(
      new Error('unavailable')
    )

    await expect(dismissPresentedPushNotification('agent:one')).resolves.toBeUndefined()
  })
})
