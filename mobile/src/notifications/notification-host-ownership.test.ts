import { createElement, useEffect } from 'react'
import * as Notifications from 'expo-notifications'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'

const connectMock = vi.fn()
const loadHostsMock = vi.fn()
const loadHostCatalogMock = vi.fn()
const hostCollectionChange = vi.hoisted(() => ({
  listener: null as null | ((change: { retiredHostIds: readonly string[] }) => void)
}))

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() }))
  },
  Platform: { OS: 'ios', Version: 18 }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn(async () => true)
}))

vi.mock('../transport/host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => connectMock(...args)
}))

vi.mock('../transport/host-store', () => ({
  loadHostCatalog: () => loadHostCatalogMock(),
  loadHosts: () => loadHostsMock()
}))

vi.mock('../transport/host-collection-changes', () => ({
  subscribeHostCollectionChanges: vi.fn(
    (listener: (change: { retiredHostIds: readonly string[] }) => void) => {
      hostCollectionChange.listener = listener
      return () => {
        hostCollectionChange.listener = null
      }
    }
  )
}))

vi.mock('../transport/connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))

import { subscribeToDesktopNotifications } from './mobile-notifications'
import { NotificationHostConnectionOwner } from './notification-host-connection-owner'
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'
import { RpcClientProvider, useCloseHost, useForceReconnect } from '../transport/client-context'
import { useAllHostClients } from '../transport/use-all-host-clients'

type FakeClient = RpcClient & {
  emitState: (state: ConnectionState) => void
  emitNotification: (event: unknown) => void
  emitNotificationReady: () => void
  getMissedCalls: () => number
  notificationSubscribeCalls: () => number
  closeCalls: () => number
}

function makeHost(
  id: string,
  lastConnected: number,
  extra: Partial<HostProfile> = {}
): HostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://${id}.internal:8787`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected,
    ...extra
  }
}

const HOSTS = [
  makeHost('local-recent', 40),
  makeHost('relay-recent', 30, { relayHostId: 'AbCdEf0123_-xyZ9' }),
  makeHost('ssh-recent', 20),
  makeHost('older-fourth', 10)
]

function makeFakeClient(
  initialState: ConnectionState = 'connected',
  connectDuringListenerRegistration = false
): FakeClient {
  let state = initialState
  let notificationReady: ((data: unknown) => void) | null = null
  let notificationSubscribes = 0
  let missedCalls = 0
  const stateListeners = new Set<(next: ConnectionState) => void>()
  const close = vi.fn()
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'notifications.getMissedSince') {
        missedCalls += 1
        return { ok: true, result: { notifications: [], epoch: 'epoch-1' } }
      }
      return { ok: true, result: undefined }
    }),
    subscribe: vi.fn((method: string, _params: unknown, listener: (data: unknown) => void) => {
      if (method === 'notifications.subscribe') {
        notificationSubscribes += 1
        notificationReady = listener
      }
      return () => {
        if (notificationReady === listener) {
          notificationReady = null
        }
      }
    }),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      stateListeners.add(listener)
      if (connectDuringListenerRegistration) {
        state = 'connected'
      }
      return () => stateListeners.delete(listener)
    },
    notifyForeground: vi.fn(),
    close,
    emitState: (next: ConnectionState) => {
      state = next
      for (const listener of stateListeners) {
        listener(next)
      }
    },
    emitNotification: (event: unknown) => {
      notificationReady?.(event)
    },
    emitNotificationReady: () => {
      notificationReady?.({ type: 'ready', subscriptionId: 'subscription-1', epoch: 'epoch-1' })
    },
    getMissedCalls: () => missedCalls,
    notificationSubscribeCalls: () => notificationSubscribes,
    closeCalls: () => close.mock.calls.length
  }
  return client as unknown as FakeClient
}

function HomeNotificationProbe(): null {
  const hostIds = HOSTS.map(({ id }) => id)
  const clients = useAllHostClients(hostIds, {
    autoConnectHostIds: hostIds.slice(0, 3),
    closeUnusedOnRelease: true
  })
  const clientKey = clients
    .map(({ hostId }) => hostId)
    .sort()
    .join(',')

  useEffect(() => {
    const cleanups = clients.map((entry) => {
      let unsubscribeNotifications: (() => void) | null = null
      const wire = (state: ConnectionState) => {
        if (state === 'connected' && !unsubscribeNotifications) {
          unsubscribeNotifications = subscribeToDesktopNotifications(entry.client, entry.hostId)
        } else if (state !== 'connected') {
          unsubscribeNotifications?.()
          unsubscribeNotifications = null
        }
      }
      wire(entry.state)
      const unsubscribeState = entry.client.onStateChange(wire)
      return () => {
        unsubscribeState()
        unsubscribeNotifications?.()
      }
    })
    return () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }, [clientKey])
  return null
}

function HomeDataProbe({ onRender }: { onRender: () => void }): null {
  onRender()
  useAllHostClients(
    HOSTS.slice(0, 3).map(({ id }) => id),
    { closeUnusedOnRelease: true }
  )
  return null
}

let closeOwnedHost: ((hostId: string) => void) | null = null
let reconnectOwnedHost: ((hostId: string) => Promise<void>) | null = null

function RePairProbe(): null {
  closeOwnedHost = useCloseHost()
  reconnectOwnedHost = useForceReconnect()
  return null
}

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('paired-host notification ownership', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    resetHostNotificationSessionsForTests()
    hostCollectionChange.listener = null
    closeOwnedHost = null
    reconnectOwnedHost = null
    loadHostCatalogMock.mockImplementation(async () =>
      (await loadHostsMock()).map((profile: HostProfile) => ({
        ...profile,
        credentialStatus: 'ready',
        profile
      }))
    )
  })

  it('keeps live and reconnect catch-up delivery for the fourth paired host', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient()
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(
            RpcClientProvider,
            null,
            createElement(NotificationHostConnectionOwner),
            createElement(HomeNotificationProbe)
          )
        )
        await flushAsync()
      })

      await act(async () => {
        for (const client of clients.values()) {
          client.emitNotificationReady()
          client.emitState('reconnecting')
          client.emitState('connected')
          client.emitNotificationReady()
        }
        await flushAsync()
      })

      expect(
        HOSTS.map(({ id }) => ({
          hostId: id,
          liveSubscribed: (clients.get(id)?.notificationSubscribeCalls() ?? 0) > 0,
          reconnectCatchUp: (clients.get(id)?.getMissedCalls() ?? 0) > 0
        }))
      ).toEqual(
        HOSTS.map(({ id }) => ({ hostId: id, liveSubscribed: true, reconnectCatchUp: true }))
      )
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('subscribes every paired host without adding Home data streams at scale', async () => {
    vi.useFakeTimers()
    const hosts = Array.from({ length: 1_000 }, (_, index) =>
      makeHost(`host-${index}`, 1_000 - index)
    )
    const clients: FakeClient[] = []
    connectMock.mockImplementation(() => {
      const client = makeFakeClient()
      clients.push(client)
      return client
    })
    loadHostsMock.mockResolvedValue(hosts)
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
        )
        await Promise.resolve()
      })
      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(clients).toHaveLength(1_000)
      expect(loadHostCatalogMock).toHaveBeenCalledOnce()
      expect(loadHostsMock).toHaveBeenCalledOnce()
      expect(clients.every((client) => client.notificationSubscribeCalls() === 1)).toBe(true)
      expect(
        clients.some((client) =>
          vi.mocked(client.subscribe).mock.calls.some(([method]) => method === 'accounts.subscribe')
        )
      ).toBe(false)
    } finally {
      restore()
      act(() => renderer?.unmount())
      vi.useRealTimers()
    }
  })

  it('acquires newly paired hosts and closes removed notification clients', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient()
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
        )
        await flushAsync()
      })

      const newlyPaired = makeHost('newly-paired', 50)
      loadHostsMock.mockResolvedValue([...HOSTS, newlyPaired])
      await act(async () => {
        hostCollectionChange.listener?.({ retiredHostIds: [] })
        await flushAsync()
      })
      expect(clients.get(newlyPaired.id)?.notificationSubscribeCalls()).toBe(1)
      expect(clients.get(HOSTS[0]!.id)?.notificationSubscribeCalls()).toBe(1)

      loadHostsMock.mockResolvedValue(HOSTS.slice(0, 3))
      await act(async () => {
        hostCollectionChange.listener?.({
          retiredHostIds: ['older-fourth', newlyPaired.id]
        })
        await flushAsync()
      })
      expect(clients.get('older-fourth')?.closeCalls()).toBe(1)
      expect(clients.get(newlyPaired.id)?.closeCalls()).toBe(1)
      expect(clients.get(HOSTS[0]!.id)?.notificationSubscribeCalls()).toBe(1)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('waits for same-id retirement before binding the replacement subscription', async () => {
    let finishSchedule: (identifier: string) => void = () => {}
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishSchedule = resolve
      })
    )
    const clients: FakeClient[] = []
    connectMock.mockImplementation(() => {
      const client = makeFakeClient()
      clients.push(client)
      return client
    })
    loadHostsMock.mockResolvedValue([HOSTS[0]])
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
        )
        await flushAsync()
      })
      clients[0]?.emitNotification({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'Held delivery',
        body: 'Keep retirement open',
        notificationId: 'agent:held'
      })
      await flushAsync()

      loadHostsMock.mockResolvedValue([])
      await act(async () => {
        hostCollectionChange.listener?.({ retiredHostIds: [HOSTS[0]!.id] })
        await flushAsync()
      })

      expect(clients).toHaveLength(1)
      expect(clients[0]?.closeCalls()).toBe(1)

      loadHostsMock.mockResolvedValue([HOSTS[0]])
      await act(async () => {
        hostCollectionChange.listener?.({ retiredHostIds: [] })
        await flushAsync()
      })
      expect(clients).toHaveLength(1)

      await act(async () => {
        finishSchedule('scheduled-held')
        await flushAsync()
      })
      await vi.waitFor(() => expect(clients).toHaveLength(2))

      await act(async () => {
        clients[1]?.emitNotificationReady()
        clients[1]?.emitState('reconnecting')
        clients[1]?.emitState('connected')
        clients[1]?.emitNotificationReady()
        await flushAsync()
      })

      expect(clients[1]?.notificationSubscribeCalls()).toBe(2)
      expect(clients[1]?.getMissedCalls()).toBe(1)
    } finally {
      finishSchedule('scheduled-held')
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('binds after a client connects during listener registration', async () => {
    const client = makeFakeClient('connecting', true)
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValue([HOSTS[0]])
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
        )
        await flushAsync()
      })
      expect(client.notificationSubscribeCalls()).toBe(1)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('reopens root notification ownership immediately after re-pair closes the old client', async () => {
    const clients: FakeClient[] = []
    connectMock.mockImplementation(() => {
      const client = makeFakeClient()
      clients.push(client)
      return client
    })
    loadHostsMock.mockResolvedValue([HOSTS[0]])
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(
            RpcClientProvider,
            null,
            createElement(NotificationHostConnectionOwner),
            createElement(RePairProbe)
          )
        )
        await flushAsync()
      })
      expect(clients[0]?.notificationSubscribeCalls()).toBe(1)

      await act(async () => {
        closeOwnedHost?.(HOSTS[0]!.id)
        await reconnectOwnedHost?.(HOSTS[0]!.id)
        await flushAsync()
      })

      expect(clients).toHaveLength(2)
      expect(clients[0]?.closeCalls()).toBe(1)
      expect(clients[1]?.notificationSubscribeCalls()).toBe(1)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('retains a live notification client during a temporary credential read', async () => {
    const host = HOSTS[0]!
    const client = makeFakeClient()
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValue([host])
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
        )
        await flushAsync()
      })

      loadHostCatalogMock.mockResolvedValueOnce([
        { ...host, credentialStatus: 'temporarily-unavailable', profile: null }
      ])
      await act(async () => {
        hostCollectionChange.listener?.({ retiredHostIds: [] })
        await flushAsync()
      })

      expect(client.closeCalls()).toBe(0)
      expect(client.notificationSubscribeCalls()).toBe(1)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it.each(['temporary credential read', 'catalog rejection'])(
    'retries a %s while the app stays foregrounded',
    async (failure) => {
      vi.useFakeTimers()
      const host = HOSTS[0]!
      if (failure === 'temporary credential read') {
        loadHostCatalogMock.mockResolvedValueOnce([
          { ...host, credentialStatus: 'temporarily-unavailable', profile: null }
        ])
      } else {
        loadHostCatalogMock.mockRejectedValueOnce(new Error('storage unavailable'))
      }
      loadHostCatalogMock.mockResolvedValueOnce([
        { ...host, credentialStatus: 'ready', profile: host }
      ])
      const client = makeFakeClient()
      connectMock.mockReturnValue(client)
      let renderer: ReactTestRenderer | null = null
      const restore = suppressRendererWarning()
      try {
        await act(async () => {
          renderer = create(
            createElement(RpcClientProvider, null, createElement(NotificationHostConnectionOwner))
          )
          await Promise.resolve()
        })
        expect(client.notificationSubscribeCalls()).toBe(0)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250)
        })
        expect(client.notificationSubscribeCalls()).toBe(1)
      } finally {
        restore()
        act(() => renderer?.unmount())
        vi.useRealTimers()
      }
    }
  )

  it('does not rerender Home for notification-only host state changes', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient()
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)
    let homeRenders = 0
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(
            RpcClientProvider,
            null,
            createElement(NotificationHostConnectionOwner),
            createElement(HomeDataProbe, { onRender: () => (homeRenders += 1) })
          )
        )
        await flushAsync()
      })
      const settledRenders = homeRenders

      await act(async () => {
        clients.get('older-fourth')?.emitState('reconnecting')
        await Promise.resolve()
      })
      expect(homeRenders).toBe(settledRenders)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('does not rerender Home when notification-only clients are added at scale', async () => {
    const initialHosts = HOSTS.slice(0, 3)
    const expandedHosts = [
      ...initialHosts,
      ...Array.from({ length: 997 }, (_, index) => makeHost(`notification-only-${index}`, 0))
    ]
    connectMock.mockImplementation(() => makeFakeClient())
    loadHostsMock.mockResolvedValue(initialHosts)
    let homeRenders = 0
    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(
            RpcClientProvider,
            null,
            createElement(NotificationHostConnectionOwner),
            createElement(HomeDataProbe, { onRender: () => (homeRenders += 1) })
          )
        )
        await flushAsync()
      })
      const settledRenders = homeRenders

      loadHostsMock.mockResolvedValue(expandedHosts)
      await act(async () => {
        hostCollectionChange.listener?.({ retiredHostIds: [] })
        await flushAsync()
      })

      expect(connectMock).toHaveBeenCalledTimes(1_000)
      expect(homeRenders).toBe(settledRenders)
    } finally {
      restore()
      act(() => renderer?.unmount())
    }
  })
})
