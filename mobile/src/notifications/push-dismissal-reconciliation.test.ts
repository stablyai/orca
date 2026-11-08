import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { loadHostCatalog } from '../transport/hosts/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
vi.mock('../transport/hosts/host-store', () => ({ loadHostCatalog: vi.fn() }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
const hostFingerprint = deriveHostFingerprint(publicKeyB64)
const id = {
  notificationId: 'old-alert',
  notificationEpoch: 'previous-host-process',
  notificationSeq: 12
}
function presented(identifier: string, overrides = {}) {
  return { request: { identifier, content: { data: { hostFingerprint, ...id, ...overrides } } } }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadHostCatalog).mockResolvedValue([{ id: 'host-a', publicKeyB64 }] as never)
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    presented('old'),
    presented('new', { notificationSeq: 14 }),
    presented('other', { hostFingerprint: 'other-host' })
  ] as never)
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
})

it('keeps alerts when an old host omits reconciliation or the request fails', async () => {
  for (const response of [{ ok: true, result: { notifications: [] } }, { ok: false }]) {
    await requestNotificationCatchup(
      { sendRequest: async () => response } as never,
      'host-a',
      () => false
    )
  }
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
})
