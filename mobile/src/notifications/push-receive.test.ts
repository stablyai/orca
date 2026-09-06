import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from './notification-reconnect-catchup'
import {
  isRemotePushTrigger,
  pushNotificationRouteData,
  shouldSuppressForegroundPush
} from './push-receive'

vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))

const storage = new Map<string, string>()

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    }),
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
  storage.clear()
  resetHostNotificationSessionsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue(hosts)
})

describe('shouldSuppressForegroundPush', () => {
  it('suppresses a push whose id and seq the socket already delivered', async () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-1'
    session.seen.add('id:agent:one#7')

    await expect(
      shouldSuppressForegroundPush(
        apnsData({
          hostFingerprint,
          notificationId: 'agent:one',
          notificationSeq: 7,
          notificationEpoch: 'epoch-1'
        })
      )
    ).resolves.toBe(true)
  })

  it('shows an unseen push and marks it so the socket replay is dropped', async () => {
    const data = apnsData({
      hostFingerprint,
      notificationId: 'agent:one',
      notificationSeq: 7,
      notificationEpoch: 'epoch-1'
    })

    await expect(shouldSuppressForegroundPush(data)).resolves.toBe(false)

    expect(getHostNotificationSession('host-1').seen.has('id:agent:one#7')).toBe(true)
    await expect(shouldSuppressForegroundPush(data)).resolves.toBe(true)
  })

  it('reads the flat stringified fields an FCM data message carries', async () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-1'
    session.seen.add('id:agent:one#7')

    await expect(
      shouldSuppressForegroundPush(
        fcmData({
          hostFingerprint,
          notificationId: 'agent:one',
          notificationSeq: 7,
          notificationEpoch: 'epoch-1'
        })
      )
    ).resolves.toBe(true)
  })

  it('keys a terminal bell on its seq alone, since it carries no notification id', async () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-1'
    session.seen.add('seq:4')

    await expect(
      shouldSuppressForegroundPush(
        apnsData({
          hostFingerprint,
          source: 'terminal-bell',
          notificationSeq: 4,
          notificationEpoch: 'epoch-1'
        })
      )
    ).resolves.toBe(true)
  })

  it('shows a push that names no counter lifetime without letting it claim a key', async () => {
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredEpoch = 'epoch-1'
    session.seen.add('seq:4')

    // Without an epoch the seq cannot be tied to this counter, so a forged seq:4
    // must neither be swallowed against it nor stop the real bell at seq 4.
    await expect(
      shouldSuppressForegroundPush(apnsData({ hostFingerprint, notificationSeq: 4 }))
    ).resolves.toBe(false)
    await expect(
      shouldSuppressForegroundPush(apnsData({ hostFingerprint, notificationSeq: 5 }))
    ).resolves.toBe(false)
    expect(session.seen.has('seq:5')).toBe(false)
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

  it('suppresses a push for a host this phone no longer has, since its tap routes nowhere', async () => {
    vi.mocked(loadHostCatalog).mockResolvedValue([])

    await expect(
      shouldSuppressForegroundPush(apnsData({ hostFingerprint, notificationSeq: 1 }))
    ).resolves.toBe(true)
  })

  it('seeds the persisted watermark before adopting, so a push cannot void it', async () => {
    storage.set(
      'orca:mobileNotificationsWatermark:host-1',
      JSON.stringify({ seq: 42, epoch: 'epoch-1' })
    )

    await shouldSuppressForegroundPush(
      apnsData({ hostFingerprint, notificationSeq: 43, notificationEpoch: 'epoch-1' })
    )

    // Unseeded, the null epoch reads as a new counter lifetime: the seq resets to 0
    // and {seq: 0} is persisted over a watermark the next reconnect still needs.
    expect(getHostNotificationSession('host-1').lastDeliveredSeq).toBe(42)
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('shows a coalesced summary without claiming the key of the one event it names', async () => {
    await expect(
      shouldSuppressForegroundPush(
        apnsData({
          hostFingerprint,
          notificationId: 'agent:one',
          notificationSeq: 7,
          coalescedCount: 3
        })
      )
    ).resolves.toBe(false)

    // Claiming it would make the socket swallow the banner for agent:one itself,
    // which the summary only ever counted.
    expect(getHostNotificationSession('host-1').seen.has('id:agent:one#7')).toBe(false)
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

  it('leaves a remote push unrouted when no host catalog could be read', () => {
    const data = { hostId: 'host-1', orca: { hostFingerprint, notificationId: 'agent:one' } }

    expect(pushNotificationRouteData(data, [], true)).toBeNull()
  })

  it('leaves a remote push with no fingerprint unrouted instead of treating it as local', () => {
    const data = { hostId: 'host-1', worktreeId: 'wt-1', source: 'agent-task-complete' }

    expect(pushNotificationRouteData(data, hosts, true)).toBeNull()
    // The same shape from this app's own scheduler still routes.
    expect(pushNotificationRouteData(data, hosts, false)).toBe(data)
  })

  it('recognises only a provider-delivered trigger as remote', () => {
    expect(isRemotePushTrigger({ type: 'push' })).toBe(true)
    expect(isRemotePushTrigger({ type: 'timeInterval', seconds: 1 })).toBe(false)
    expect(isRemotePushTrigger({ channelId: 'orca-desktop' })).toBe(false)
    expect(isRemotePushTrigger(null)).toBe(false)
    expect(isRemotePushTrigger(undefined)).toBe(false)
  })

  it('drops a gateway payload that pairs an unresolvable fingerprint with a stray hostId', () => {
    const data = {
      hostId: 'host-1',
      orca: { hostFingerprint: '0123456789abcdef', notificationId: 'agent:one' }
    }

    // Returning the raw data would let the stray hostId route a tap the push never named.
    expect(pushNotificationRouteData(data, hosts)).toBeNull()
    expect(
      getNotificationNavigationTarget(pushNotificationRouteData(data, hosts), {
        knownHostIds: new Set(['host-1'])
      })
    ).toBeNull()
  })
})
