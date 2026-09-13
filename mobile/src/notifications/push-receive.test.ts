import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { setNotificationViewingWorkspace } from './notification-viewing-policy'
vi.mock('./push-tray-dismissal', () => ({ dismissPresentedPushNotification: vi.fn() }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  foregroundNotificationBehavior,
  canPresentForegroundPush,
  isRemotePushTrigger,
  pushNotificationRouteData,
  resetForegroundPushClaimsForTests
} from './push-receive'

async function shouldSuppressForegroundPush(data: unknown): Promise<boolean> {
  return !(await foregroundNotificationBehavior({ request: { content: { data } } }))
    .shouldShowBanner
}

vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => storage.set(key, value))
  }
}))

const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
const hostFingerprint = Buffer.from(sha256(Buffer.alloc(32, 1)))
  .toString('base64url')
  .slice(0, 16)
const hosts = [{ id: 'host-1', publicKeyB64 }] as unknown as HostCatalogEntry[]
const otherPublicKeyB64 = Buffer.alloc(32, 2).toString('base64')
const otherHostFingerprint = Buffer.from(sha256(Buffer.alloc(32, 2)))
  .toString('base64url')
  .slice(0, 16)

function apnsData(orca: Record<string, unknown>): unknown {
  return { aps: { alert: { title: 'Orca', body: 'Agent needs input' } }, orca }
}
function fcmData(orca: Record<string, unknown>): unknown {
  return Object.fromEntries(Object.entries(orca).map(([key, value]) => [key, String(value)]))
}

beforeEach(() => {
  vi.clearAllMocks()
  AppState.currentState = 'background'
  setNotificationViewingWorkspace(null)
  storage.clear()
  storage.set('orca:pushServiceNotificationsEnabled', 'true')
  resetForegroundPushClaimsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue([
    ...hosts,
    { id: 'host-2', publicKeyB64: otherPublicKeyB64 }
  ] as unknown as HostCatalogEntry[])
})

describe('shouldSuppressForegroundPush', () => {
  const push = () =>
    apnsData({
      hostFingerprint,
      notificationId: 'agent:one',
      notificationSeq: 7,
      notificationEpoch: 'epoch-1'
    })

  it('allows one eligible native push and suppresses an in-process duplicate', async () => {
    await expect(shouldSuppressForegroundPush(push())).resolves.toBe(false)
    await expect(shouldSuppressForegroundPush(push())).resolves.toBe(true)
  })

  it('reads flat FCM fields and allows the first native push', async () => {
    await expect(
      shouldSuppressForegroundPush(
        fcmData({
          hostFingerprint,
          notificationId: 'agent:one',
          notificationSeq: 8,
          notificationEpoch: 'epoch-1'
        })
      )
    ).resolves.toBe(false)
  })

  it('deduplicates ID-less bells by host, epoch, and valid sequence', async () => {
    const bell = (overrides: Record<string, unknown> = {}) =>
      apnsData({
        hostFingerprint,
        source: 'terminal-bell',
        notificationSeq: 4,
        notificationEpoch: 'epoch-1',
        ...overrides
      })
    await expect(shouldSuppressForegroundPush(bell())).resolves.toBe(false)
    await expect(shouldSuppressForegroundPush(bell())).resolves.toBe(true)
    await expect(shouldSuppressForegroundPush(bell({ notificationSeq: 5 }))).resolves.toBe(false)
    await expect(
      shouldSuppressForegroundPush(bell({ notificationEpoch: 'epoch-2' }))
    ).resolves.toBe(false)
    await expect(
      shouldSuppressForegroundPush(bell({ hostFingerprint: otherHostFingerprint }))
    ).resolves.toBe(false)
  })

  it('does not claim invalid sequence values as duplicate identities', async () => {
    const invalid = apnsData({
      hostFingerprint,
      source: 'plugin',
      notificationSeq: 1.5,
      notificationEpoch: 'epoch-1'
    })
    await expect(shouldSuppressForegroundPush(invalid)).resolves.toBe(false)
    await expect(shouldSuppressForegroundPush(invalid)).resolves.toBe(false)
  })

  it('suppresses pushes for an unpaired host', async () => {
    vi.mocked(loadHostCatalog).mockResolvedValue([])
    await expect(
      shouldSuppressForegroundPush(apnsData({ hostFingerprint, notificationSeq: 1 }))
    ).resolves.toBe(true)
  })

  it('suppresses a push after a matching persisted dismissal', async () => {
    const { rememberPushDismissal } = await import('./push-dismissal-watermarks')
    const payload = {
      hostFingerprint,
      notificationId: 'dismissed',
      notificationSeq: 2,
      notificationEpoch: 'epoch-1'
    }
    await rememberPushDismissal(payload)
    await expect(shouldSuppressForegroundPush(apnsData(payload))).resolves.toBe(true)
  })

  it('fails closed for recognized pushes when suppression checks throw', async () => {
    const dismissals = await import('./push-dismissal-watermarks')
    const dismissalSpy = vi
      .spyOn(dismissals, 'wasPushDismissed')
      .mockRejectedValueOnce(new Error('dismissal read failed'))
    await expect(
      foregroundNotificationBehavior({ request: { content: { data: push() } } })
    ).resolves.toMatchObject({ shouldShowBanner: false, shouldShowList: false })
    dismissalSpy.mockRestore()
  })

  it('keeps unrelated notifications visible when suppression checks throw', async () => {
    const dismissals = await import('./push-dismissal-watermarks')
    const dismissalSpy = vi
      .spyOn(dismissals, 'wasPushDismissed')
      .mockRejectedValue(new Error('dismissal read failed'))
    await expect(
      foregroundNotificationBehavior({
        request: { content: { data: { title: 'Other app notification' } } }
      })
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true })
    dismissalSpy.mockRestore()
  })
})

describe('pushNotificationRouteData', () => {
  it('routes a tap by mapping the fingerprint to the paired host id', () => {
    const data = pushNotificationRouteData(
      apnsData({ hostFingerprint, worktreeId: 'repo::/feature', source: 'agent-task-complete' }),
      hosts
    )
    expect(getNotificationNavigationTarget(data, { knownHostIds: new Set(['host-1']) })).toEqual({
      hostId: 'host-1',
      sessionTarget: {
        name: '[hostId]/session/[worktreeId]',
        params: { hostId: 'host-1', worktreeId: 'repo::/feature' }
      }
    })
  })

  it('maps a push without a worktree to the host screen', () => {
    const data = pushNotificationRouteData(
      fcmData({ hostFingerprint, source: 'terminal-bell' }),
      hosts
    )
    expect(getNotificationNavigationTarget(data)).toEqual({ hostId: 'host-1', sessionTarget: null })
  })

  it('keeps local data untouched and rejects an unresolvable remote fingerprint', () => {
    const local = { hostId: 'host-9', source: 'agent-task-complete' }
    expect(pushNotificationRouteData(local, hosts)).toBe(local)
    expect(
      pushNotificationRouteData(
        { hostId: 'host-1', orca: { hostFingerprint: 'unknown' } },
        hosts,
        true
      )
    ).toBeNull()
  })

  it('recognises only provider-delivered triggers', () => {
    expect(isRemotePushTrigger({ type: 'push' })).toBe(true)
    expect(isRemotePushTrigger({ type: 'timeInterval' })).toBe(false)
  })
})

it('uses one delivery snapshot for sound and viewing even when settings change during host lookup', async () => {
  AppState.currentState = 'active'
  setNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'folder' })
  storage.set(
    'orca:notificationDeliveryPreferences',
    JSON.stringify({
      sound: false,
      suppressWhileViewing: false
    })
  )
  vi.mocked(loadHostCatalog).mockImplementationOnce(async () => {
    storage.set(
      'orca:notificationDeliveryPreferences',
      JSON.stringify({
        sound: true,
        suppressWhileViewing: true
      })
    )
    return hosts
  })
  const behavior = await foregroundNotificationBehavior({
    request: {
      content: {
        data: apnsData({
          hostFingerprint,
          worktreeId: 'folder',
          notificationEpoch: 'snapshot',
          notificationSeq: 1
        })
      }
    }
  })
  expect(behavior).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false })
  expect(
    vi
      .mocked(AsyncStorage.getItem)
      .mock.calls.filter(([key]) => key === 'orca:notificationDeliveryPreferences')
  ).toHaveLength(1)
})

it.each(['apns', 'fcm'])(
  'routes %s pane payload to the correct host, workspace and pane',
  (provider) => {
    const paneKey = 'tab-b:11111111-1111-4111-8111-111111111111'
    const payload = { hostFingerprint, worktreeId: 'folder:/work', paneKey }
    const data = provider === 'apns' ? { orca: payload } : payload
    const routed = pushNotificationRouteData(data, [{ id: 'host', publicKeyB64 }], true)
    expect(getNotificationNavigationTarget(routed)?.sessionTarget?.params).toEqual({
      hostId: 'host',
      worktreeId: 'folder:/work',
      paneKey
    })
  }
)

it('preflight does not consume the final presentation claim and observes later dismissals', async () => {
  const payload = {
    hostFingerprint,
    notificationId: 'preflight',
    notificationEpoch: 'epoch',
    notificationSeq: 4
  }
  await expect(canPresentForegroundPush(payload)).resolves.toBe(true)
  await expect(shouldSuppressForegroundPush(apnsData(payload))).resolves.toBe(false)
  const { rememberPushDismissal } = await import('./push-dismissal-watermarks')
  await rememberPushDismissal(payload)
  await expect(canPresentForegroundPush(payload)).resolves.toBe(false)
  await expect(shouldSuppressForegroundPush(apnsData(payload))).resolves.toBe(true)
})
