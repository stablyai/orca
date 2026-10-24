import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import {
  setInPageNotificationViewingWorkspace,
  setNotificationViewingWorkspace
} from './notification-viewing-policy'
import {
  noteBridgeHostClientMessage,
  noteBridgeHostServerPayload,
  noteInPageBackClaim,
  noteInPageStorageWrite
} from './in-page-notification-navigation'
import { withLastVisitedWorktree } from '../worktree/last-visited-worktree-by-host'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../worktree/last-visited-worktree-repo'
import { sessionTabPaneKey } from '../session/notification-pane-tab'
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

  it('opens a server workspace on its server, from either provider shape', () => {
    for (const providerData of [apnsData, fcmData]) {
      const data = pushNotificationRouteData(
        providerData({
          hostFingerprint,
          worktreeId: 'repo::/srv/feature',
          executionHost: 'runtime:env-1',
          source: 'agent-task-complete'
        }),
        hosts,
        true
      )
      expect(getNotificationNavigationTarget(data)?.sessionTarget?.params).toEqual({
        hostId: 'host-1',
        worktreeId: 'repo::/srv/feature',
        executionHost: 'runtime:env-1'
      })
    }
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

it('shows notifications from another tab in the same workspace while suppressing the active tab', async () => {
  AppState.currentState = 'active'
  let seq = 0
  const presentPane = (paneKey?: string) =>
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      ...(paneKey ? { paneKey } : {}),
      notificationId: `pane-${++seq}`,
      notificationEpoch: 'epoch',
      notificationSeq: seq
    })
  setNotificationViewingWorkspace({
    hostId: 'host-1',
    worktreeId: 'repo::/work',
    paneKey: 'tab-a:11111111-1111-4111-8111-111111111111'
  })
  await expect(presentPane('tab-a:11111111-1111-4111-8111-111111111111')).resolves.toBe(false)
  await expect(presentPane('tab-b:22222222-2222-4222-8222-222222222222')).resolves.toBe(true)
})

it('keeps suppressing the active in-page tab across ready/drawer back-claim drops until leaving the session', async () => {
  AppState.currentState = 'active'
  const paneKey = sessionTabPaneKey({
    type: 'terminal',
    id: 'tab-a::leaf-1',
    title: 'Claude',
    terminal: 'pty-1',
    isActive: true
  })
  expect(paneKey).toBe('tab-a:leaf-1')
  const storedInSession = withLastVisitedWorktree(null, {
    hostId: 'host-1',
    worktreeId: 'repo::/work',
    paneKey,
    inSession: true
  })
  noteInPageStorageWrite(
    'host-1',
    LAST_VISITED_WORKTREE_STORAGE_KEY,
    storedInSession,
    () => {},
    setInPageNotificationViewingWorkspace
  )
  setNotificationViewingWorkspace(null, { preserveInPageForHostId: 'host-1' })
  noteInPageBackClaim(
    false,
    '/h/host-1',
    'host-1',
    () => {},
    setInPageNotificationViewingWorkspace
  )
  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-a:leaf-1',
      notificationId: 'in-page-active',
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
  ).resolves.toBe(false)

  const storedLeftSession = withLastVisitedWorktree(storedInSession, {
    hostId: 'host-1',
    worktreeId: 'repo::/work',
    inSession: false
  })
  noteInPageStorageWrite(
    'host-1',
    LAST_VISITED_WORKTREE_STORAGE_KEY,
    storedLeftSession,
    () => {},
    setInPageNotificationViewingWorkspace
  )
  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-a:leaf-1',
      notificationId: 'in-page-left',
      notificationEpoch: 'epoch',
      notificationSeq: 2
    })
  ).resolves.toBe(true)
})

it('suppresses notifications when the active session is on a duplicate host entry sharing the same desktop fingerprint', async () => {
  AppState.currentState = 'active'
  vi.mocked(loadHostCatalog).mockResolvedValue([
    { id: 'host-stale', publicKeyB64 },
    { id: 'host-active', publicKeyB64 }
  ] as unknown as HostCatalogEntry[])
  setInPageNotificationViewingWorkspace({
    hostId: 'host-active',
    worktreeId: 'repo::/work',
    paneKey: 'tab-a:leaf-1'
  })
  const payload = {
    hostFingerprint,
    worktreeId: 'repo::/work',
    paneKey: 'tab-a:leaf-1',
    notificationId: 'dup-host-1',
    notificationEpoch: 'epoch',
    notificationSeq: 1
  }
  await expect(canPresentForegroundPush(payload, 'host-active')).resolves.toBe(false)
  await expect(canPresentForegroundPush(payload)).resolves.toBe(false)
  await expect(
    shouldSuppressForegroundPush({
      hostId: 'host-active',
      ...payload
    })
  ).resolves.toBe(true)
})

it('tracks active session tab and suppression via BridgeHost RPC even when WebView bundle omits paneKey in storage', async () => {
  AppState.currentState = 'active'
  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'subscribe',
      id: 'tabs-sub-1',
      method: 'session.tabs.subscribe',
      params: { worktree: 'id:repo::/work' }
    },
    () => true
  )
  noteBridgeHostServerPayload('host-1', 'tabs-sub-1', {
    worktree: 'repo::/work',
    tabs: [
      {
        id: 'tab-a::leaf-1',
        parentTabId: 'tab-a',
        leafId: 'leaf-1',
        type: 'terminal',
        title: 'Claude',
        isActive: true,
        terminal: 'term-1',
        agentStatus: { paneKey: 'tab-a:leaf-1', state: 'working' }
      },
      {
        id: 'tab-b::leaf-2',
        parentTabId: 'tab-b',
        leafId: 'leaf-2',
        type: 'terminal',
        title: 'Codex',
        isActive: false,
        terminal: 'term-2',
        agentStatus: { paneKey: 'tab-b:leaf-2', state: 'working' }
      }
    ]
  })

  const legacyStored = withLastVisitedWorktree(null, {
    hostId: 'host-1',
    worktreeId: 'repo::/work'
  })
  noteInPageStorageWrite(
    'host-1',
    LAST_VISITED_WORKTREE_STORAGE_KEY,
    legacyStored,
    () => {},
    setInPageNotificationViewingWorkspace
  )

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-a:leaf-1',
      notificationId: 'bridge-tab-a',
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
  ).resolves.toBe(false)

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:leaf-2',
      notificationId: 'bridge-tab-b',
      notificationEpoch: 'epoch',
      notificationSeq: 2
    })
  ).resolves.toBe(true)

  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'subscribe',
      id: 'term-sub-2',
      method: 'terminal.subscribe',
      params: { handle: 'term-2' }
    },
    () => true
  )

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:leaf-2',
      notificationId: 'bridge-tab-b-after-switch',
      notificationEpoch: 'epoch',
      notificationSeq: 3
    })
  ).resolves.toBe(false)

  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'cancel',
      target: 'subscription',
      id: 'tabs-sub-1'
    },
    () => true
  )

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:leaf-2',
      notificationId: 'bridge-after-leave',
      notificationEpoch: 'epoch',
      notificationSeq: 4
    })
  ).resolves.toBe(true)
})

it('decodes session.tabs.subscribe tabsDelta updates, tracks agentSession RPCs, and tolerates writeStorage errors', async () => {
  AppState.currentState = 'active'
  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'subscribe',
      id: 'tabs-delta-sub',
      method: 'session.tabs.subscribe',
      params: { worktree: 'id:repo::/work' }
    },
    () => true
  )
  noteBridgeHostServerPayload('host-1', 'tabs-delta-sub', {
    type: 'snapshot',
    worktree: 'repo::/work',
    tabsRevision: 1,
    activeTabId: 'tab-a',
    tabs: [
      {
        id: 'tab-a',
        parentTabId: 'tab-a',
        leafId: 'pane:1',
        type: 'terminal',
        title: 'Shell 1',
        isActive: true,
        terminal: 'term-1'
      }
    ]
  })

  noteInPageStorageWrite(
    'host-1',
    LAST_VISITED_WORKTREE_STORAGE_KEY,
    withLastVisitedWorktree(null, { hostId: 'host-1', worktreeId: 'repo::/work' }),
    () => {
      throw new TypeError('publishStorage is not a function')
    },
    setInPageNotificationViewingWorkspace
  )

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-a:11111111-1111-4111-8111-111111111111',
      notificationId: 'legacy-leaf-match',
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
  ).resolves.toBe(false)

  noteBridgeHostServerPayload('host-1', 'tabs-delta-sub', {
    type: 'updated',
    worktree: 'repo::/work',
    tabsRevision: 2,
    activeTabId: 'tab-b',
    tabsDelta: {
      baseRevision: 1,
      tabs: [
        {
          id: 'tab-a',
          parentTabId: 'tab-a',
          leafId: 'pane:1',
          type: 'terminal',
          title: 'Shell 1',
          isActive: false,
          terminal: 'term-1'
        },
        {
          id: 'tab-b',
          parentTabId: 'tab-b',
          leafId: '22222222-2222-4222-8222-222222222222',
          type: 'terminal',
          title: 'Claude',
          isActive: true,
          terminal: 'term-2'
        }
      ]
    }
  })

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:22222222-2222-4222-8222-222222222222',
      notificationId: 'delta-tab-b',
      notificationEpoch: 'epoch',
      notificationSeq: 2
    })
  ).resolves.toBe(false)

  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'request',
      id: 'agent-send-1',
      method: 'agentSession.send',
      params: { sessionId: 'sess-structured-1', text: 'hello' }
    },
    () => true
  )

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'structured-agent-session-sess-structured-1:sess-structured-1',
      notificationId: 'structured-send-1',
      notificationEpoch: 'epoch',
      notificationSeq: 3
    })
  ).resolves.toBe(false)

  // Switching tabs via LAST_VISITED_WORKTREE_STORAGE_KEY must not retain stale tabId/terminalHandle
  // or be overwritten by subsequent server snapshots whose activeTabId is on a different desktop tab
  // or by background session.tabs.list polls for other worktrees.
  noteInPageStorageWrite(
    'host-1',
    LAST_VISITED_WORKTREE_STORAGE_KEY,
    withLastVisitedWorktree(null, {
      hostId: 'host-1',
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:22222222-2222-4222-8222-222222222222'
    }),
    () => {},
    setInPageNotificationViewingWorkspace
  )
  noteBridgeHostServerPayload('host-1', 'tabs-delta-sub', {
    type: 'updated',
    worktree: 'repo::/work',
    tabsRevision: 3,
    activeTabId: 'tab-a',
    tabs: [
      {
        id: 'tab-a',
        parentTabId: 'tab-a',
        leafId: '11111111-1111-4111-8111-111111111111',
        type: 'terminal',
        title: 'Shell 1',
        isActive: true,
        terminal: 'term-1'
      },
      {
        id: 'tab-b',
        parentTabId: 'tab-b',
        leafId: '22222222-2222-4222-8222-222222222222',
        type: 'terminal',
        title: 'Claude',
        isActive: false,
        terminal: 'term-2'
      }
    ]
  })
  noteBridgeHostClientMessage(
    'host-1',
    {
      v: 1,
      type: 'request',
      id: 'bg-recent-cards-list',
      method: 'session.tabs.list',
      params: { worktree: 'id:repo::/other-worktree' }
    },
    () => true
  )
  noteBridgeHostServerPayload('host-1', 'bg-recent-cards-list', {
    worktree: 'repo::/other-worktree',
    activeTabId: 'other-tab',
    tabs: [
      {
        id: 'other-tab',
        parentTabId: 'other-tab',
        leafId: '33333333-3333-4333-8333-333333333333',
        type: 'terminal',
        title: 'Other',
        isActive: true,
        terminal: 'term-other'
      }
    ]
  })

  await expect(
    canPresentForegroundPush({
      hostFingerprint,
      worktreeId: 'repo::/work',
      paneKey: 'tab-b:22222222-2222-4222-8222-222222222222',
      notificationId: 'stay-on-tab-b',
      notificationEpoch: 'epoch',
      notificationSeq: 4
    })
  ).resolves.toBe(false)
})
