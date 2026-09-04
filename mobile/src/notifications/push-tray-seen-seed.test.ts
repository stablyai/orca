import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from './notification-reconnect-catchup'
import { markPresentedPushesSeen, readPresentedPushSeenKeys } from './push-tray-seen-seed'

vi.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: vi.fn() }))

vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined)
  }
}))

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')
const hostFingerprint = Buffer.from(sha256(publicKey)).toString('base64url').slice(0, 16)

const hosts = [{ id: 'host-1', publicKeyB64 }] as unknown as HostCatalogEntry[]

function presented(orca: Record<string, unknown>): unknown {
  const identifier = `tray-${String(orca.notificationId ?? 'bell')}`
  return { request: { identifier, content: { data: { orca } } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetHostNotificationSessionsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue(hosts)
})

describe('readPresentedPushSeenKeys', () => {
  it('keys the tray entries the gateway pushed for this host', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented({ hostFingerprint, notificationId: 'agent:one', notificationSeq: 6 }),
      presented({ hostFingerprint, notificationSeq: 7 })
    ] as never)

    await expect(readPresentedPushSeenKeys('host-1')).resolves.toEqual([
      { key: 'id:agent:one#6', epoch: undefined },
      { key: 'seq:7', epoch: undefined }
    ])
  })

  it('ignores a tray entry belonging to another paired host', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented({ hostFingerprint: '0123456789abcdef', notificationId: 'agent:one' })
    ] as never)

    await expect(readPresentedPushSeenKeys('host-1')).resolves.toEqual([])
  })

  it('ignores a coalesced summary, whose key names a banner nobody has seen', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented({
        hostFingerprint,
        notificationId: 'agent:one',
        notificationSeq: 6,
        coalescedCount: 3
      })
    ] as never)

    await expect(readPresentedPushSeenKeys('host-1')).resolves.toEqual([])
  })

  it('ignores a locally scheduled notification, which the socket path already owns', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: 'tray-1', content: { data: { hostId: 'host-1' } } } }
    ] as never)

    await expect(readPresentedPushSeenKeys('host-1')).resolves.toEqual([])
    expect(loadHostCatalog).toHaveBeenCalled()
  })

  it('stays silent on a native shell that cannot query the tray', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValue(
      new Error('unavailable')
    )

    await expect(readPresentedPushSeenKeys('host-1')).resolves.toEqual([])
  })
})

describe('markPresentedPushesSeen', () => {
  it('claims the keys without touching the watermark', () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-1'

    markPresentedPushesSeen(session, [{ key: 'id:agent:one#9', epoch: 'epoch-1' }])

    expect(session.seen.has('id:agent:one#9')).toBe(true)
    // A push seq proves one event was shown, not that everything below it was.
    expect(session.lastDeliveredSeq).toBe(0)
  })

  it('drops a key from a desktop lifetime that has already been retired', () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-2'

    markPresentedPushesSeen(session, [{ key: 'seq:4', epoch: 'epoch-1' }])

    // The new counter re-issues seq 4, so the stale key would drop a real bell.
    expect(session.seen.has('seq:4')).toBe(false)
  })
})
