import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from './notification-reconnect-catchup'
import { pushNotificationRouteData, shouldSuppressForegroundPush } from './push-receive'

vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')
const hostFingerprint = Buffer.from(sha256(publicKey)).toString('base64url').slice(0, 16)

const hosts = [{ id: 'host-1', publicKeyB64 }] as unknown as HostCatalogEntry[]

// APNs nests Orca's fields beside `aps`; FCM sends them flat and stringified.
function apnsData(orca: Record<string, unknown>): unknown {
  return { aps: { alert: { title: 'Orca', body: 'Agent needs input' } }, orca }
}

function fcmData(orca: Record<string, unknown>): unknown {
  return Object.fromEntries(Object.entries(orca).map(([key, value]) => [key, String(value)]))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetHostNotificationSessionsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue(hosts)
})

describe('shouldSuppressForegroundPush', () => {
  it('suppresses a push whose id and seq the socket already delivered', async () => {
    getHostNotificationSession('host-1').seen.add('id:agent:one#7')

    await expect(
      shouldSuppressForegroundPush(
        apnsData({ hostFingerprint, notificationId: 'agent:one', notificationSeq: 7 })
      )
    ).resolves.toBe(true)
  })

  it('shows an unseen push and marks it so the socket replay is dropped', async () => {
    const data = apnsData({ hostFingerprint, notificationId: 'agent:one', notificationSeq: 7 })

    await expect(shouldSuppressForegroundPush(data)).resolves.toBe(false)

    expect(getHostNotificationSession('host-1').seen.has('id:agent:one#7')).toBe(true)
    await expect(shouldSuppressForegroundPush(data)).resolves.toBe(true)
  })

  it('reads the flat stringified fields an FCM data message carries', async () => {
    getHostNotificationSession('host-1').seen.add('id:agent:one#7')

    await expect(
      shouldSuppressForegroundPush(
        fcmData({ hostFingerprint, notificationId: 'agent:one', notificationSeq: 7 })
      )
    ).resolves.toBe(true)
  })

  it('keys a terminal bell on its seq alone, since it carries no notification id', async () => {
    getHostNotificationSession('host-1').seen.add('seq:4')

    await expect(
      shouldSuppressForegroundPush(
        apnsData({ hostFingerprint, source: 'terminal-bell', notificationSeq: 4 })
      )
    ).resolves.toBe(true)
  })

  it('voids seen keys from a previous desktop lifetime before testing its own', async () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-old'
    session.seen.add('seq:4')

    await expect(
      shouldSuppressForegroundPush(
        apnsData({ hostFingerprint, notificationSeq: 4, notificationEpoch: 'epoch-new' })
      )
    ).resolves.toBe(false)
  })

  it('leaves a locally scheduled notification to the existing path', async () => {
    await expect(
      shouldSuppressForegroundPush({ hostId: 'host-1', source: 'agent-task-complete' })
    ).resolves.toBe(false)
    expect(loadHostCatalog).not.toHaveBeenCalled()
  })

  it('shows a push whose host is no longer paired rather than dropping it silently', async () => {
    vi.mocked(loadHostCatalog).mockResolvedValue([])

    await expect(
      shouldSuppressForegroundPush(apnsData({ hostFingerprint, notificationSeq: 1 }))
    ).resolves.toBe(false)
  })
})

describe('pushNotificationRouteData', () => {
  it('routes a tap by mapping the fingerprint to the paired host id', () => {
    const data = pushNotificationRouteData(
      apnsData({
        hostFingerprint,
        notificationId: 'agent:one',
        worktreeId: 'repo::/Users/me/orca/workspaces/feature',
        source: 'agent-task-complete'
      }),
      hosts
    )

    expect(getNotificationNavigationTarget(data, { knownHostIds: new Set(['host-1']) })).toEqual({
      hostId: 'host-1',
      sessionTarget: {
        name: '[hostId]/session/[worktreeId]',
        params: { hostId: 'host-1', worktreeId: 'repo::/Users/me/orca/workspaces/feature' }
      }
    })
  })

  it('falls back to the host screen for a push with no worktree', () => {
    const data = pushNotificationRouteData(
      fcmData({ hostFingerprint, source: 'terminal-bell' }),
      hosts
    )

    expect(getNotificationNavigationTarget(data)).toEqual({
      hostId: 'host-1',
      sessionTarget: null
    })
  })

  it('passes locally scheduled data through untouched', () => {
    const data = { hostId: 'host-9', source: 'agent-task-complete' }

    expect(pushNotificationRouteData(data, hosts)).toBe(data)
  })

  it('leaves an unresolvable fingerprint unrouted rather than guessing a host', () => {
    const data = pushNotificationRouteData(apnsData({ hostFingerprint: '0123456789abcdef' }), hosts)

    expect(getNotificationNavigationTarget(data)).toBeNull()
  })
})
