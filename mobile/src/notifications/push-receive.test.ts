import '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { setNotificationViewingWorkspace } from './notification-viewing-policy'
vi.mock('./push-tray-dismissal', () => ({ dismissPresentedPushNotification: vi.fn() }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/hosts/host-store'
import type { HostCatalogEntry } from '../transport/hosts/host-profile'

import {
  foregroundNotificationBehavior,
  canPresentForegroundPush,
  resetForegroundPushClaimsForTests
} from './push-receive'

async function shouldSuppressForegroundPush(data: unknown): Promise<boolean> {
  return !(await foregroundNotificationBehavior({ request: { content: { data } } }))
    .shouldShowBanner
}

vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }))
vi.mock('../transport/hosts/host-store', () => ({ loadHostCatalog: vi.fn() }))
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
})

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

it('allows the viewed workspace after backgrounding during eligibility reads', async () => {
  const payload = {
    hostFingerprint,
    worktreeId: 'workspace',
    notificationId: 'background-transition',
    notificationEpoch: 'epoch',
    notificationSeq: 1
  }
  setNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'workspace' })
  AppState.currentState = 'active'
  await expect(canPresentForegroundPush(payload)).resolves.toBe(false)
  let resolveHosts!: (value: HostCatalogEntry[]) => void
  vi.mocked(loadHostCatalog).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveHosts = resolve
    })
  )
  const eligibility = canPresentForegroundPush(payload)
  await vi.waitFor(() => expect(resolveHosts).toBeDefined())
  AppState.currentState = 'background'
  resolveHosts(hosts)
  await expect(eligibility).resolves.toBe(true)
  await expect(shouldSuppressForegroundPush(apnsData(payload))).resolves.toBe(false)
})

it('silences only the viewed workspace on its own host, desktop or server', async () => {
  AppState.currentState = 'active'
  let seq = 0
  const present = (executionHost?: string) =>
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      ...(executionHost ? { executionHost } : {}),
      notificationId: `viewing-${++seq}`,
      notificationEpoch: 'epoch',
      notificationSeq: seq
    })
  setNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'repo::/work' })
  await expect(present()).resolves.toBe(false)
  await expect(present('runtime:env-1')).resolves.toBe(true)
  setNotificationViewingWorkspace({
    hostId: 'host-1',
    worktreeId: 'repo::/work',
    executionHost: 'runtime:env-1'
  })
  await expect(present('runtime:env-1')).resolves.toBe(false)
  await expect(present()).resolves.toBe(true)
})
