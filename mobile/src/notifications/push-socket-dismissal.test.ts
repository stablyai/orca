import { expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { dismissHostPushNotification } from './push-socket-dismissal'
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined }
}))

it('a socket dismissal cannot clear another desktop or a newer notification', async () => {
  const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
  vi.mocked(loadHostCatalog).mockResolvedValue([{ id: 'host-a', publicKeyB64 }] as never)
  const hostFingerprint = deriveHostFingerprint(publicKeyB64)
  const event = {
    type: 'dismiss' as const,
    notificationId: 'same',
    notificationEpoch: 'epoch',
    notificationSeq: 2
  }
  const presented = (identifier: string, overrides: Record<string, unknown>) => ({
    request: { identifier, content: { data: { hostFingerprint, ...event, ...overrides } } }
  })
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    presented('older', { notificationSeq: 1 }),
    presented('newer', { notificationSeq: 3 }),
    presented('other', { hostFingerprint: 'other-host' }),
    presented('restarted', { notificationEpoch: 'new-epoch' })
  ] as never)
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  await dismissHostPushNotification(event, 'host-a')
  expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([['older']])
})

it('supports ID-only legacy dismissal while preserving host isolation', async () => {
  vi.clearAllMocks()
  const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
  vi.mocked(loadHostCatalog).mockResolvedValue([{ id: 'host-a', publicKeyB64 }] as never)
  const hostFingerprint = deriveHostFingerprint(publicKeyB64)
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    {
      request: {
        identifier: 'legacy',
        content: { data: { hostFingerprint, notificationId: 'same' } }
      }
    },
    {
      request: {
        identifier: 'foreign',
        content: { data: { hostFingerprint: 'other-host', notificationId: 'same' } }
      }
    }
  ] as never)
  await dismissHostPushNotification({ type: 'dismiss', notificationId: 'same' }, 'host-a')
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('legacy')
})
