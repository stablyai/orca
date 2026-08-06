import { createElement, Fragment, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAllHostClients } from './use-all-host-clients'
import { useFocusedSettingsHostClients } from './settings-host-client-connections'
import {
  RpcClientProvider,
  useHostClient,
  usePrimeHosts,
  useRpcClientContext,
  type RpcClientContextValue
} from './client-context'
import { selectHomeAutoConnectHostIds } from './home-host-auto-connect'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, HostProfile } from './types'

const connectMock = vi.fn()
const loadHostsMock = vi.fn()
const routeFocus = vi.hoisted(() => ({
  effect: null as null | (() => void | (() => void))
}))

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    routeFocus.effect = effect
  }
}))

vi.mock('./host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('./connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))

type FakeClient = RpcClient & {
  closeMock: ReturnType<typeof vi.fn>
}

function makeFakeClient(initialState: ConnectionState): FakeClient {
  const listeners = new Set<(state: ConnectionState) => void>()
  const closeMock = vi.fn()
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => initialState,
    getReconnectAttempt: () => (initialState === 'reconnecting' ? 4 : 0),
    getLastConnectedAt: () => null,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyForeground: vi.fn(),
    close: closeMock,
    closeMock
  } as FakeClient
}

function host(id: string, lastConnected: number, extra: Partial<HostProfile> = {}): HostProfile {
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
  host('direct-recent', 50),
  host('relay-recent', 40, { relayHostId: 'AbCdEf0123_-xyZ9' }),
  host('ssh-provider-recent', 30),
  host('folder-workspace-host', 20),
  host('offline-host', 10)
]
const HOST_IDS = HOSTS.map((profile) => profile.id)
const HOME_HOST_IDS = selectHomeAutoConnectHostIds(HOSTS)

let context: RpcClientContextValue | null = null

function ContextProbe(): null {
  context = useRpcClientContext()
  return null
}

function HomeProbe(): null {
  useAllHostClients(HOST_IDS, {
    autoConnectHostIds: HOME_HOST_IDS,
    closeUnusedOnRelease: true
  })
  const primeHosts = usePrimeHosts()
  useEffect(() => {
    primeHosts(HOSTS)
  }, [primeHosts])
  return null
}

function SettingsProbe(): null {
  useAllHostClients(HOST_IDS, {
    closeUnusedOnRelease: true
  })
  return null
}

function FocusedSettingsProbe(): null {
  useFocusedSettingsHostClients(HOST_IDS)
  return null
}

function DynamicSettingsProbe({ hostIds }: { hostIds: string[] }): null {
  useAllHostClients(hostIds, { closeUnusedOnRelease: true })
  return null
}

function DetailProbe({ hostId }: { hostId: string }): null {
  useHostClient(hostId)
  return null
}

type Screen = 'empty' | 'home' | 'settings'

function TestApp({
  screen,
  detailHostId
}: {
  screen: Screen
  detailHostId?: string
}): React.JSX.Element {
  const screenProbe =
    screen === 'home'
      ? createElement(HomeProbe)
      : screen === 'settings'
        ? createElement(SettingsProbe)
        : null
  return createElement(
    RpcClientProvider,
    null,
    createElement(
      Fragment,
      null,
      createElement(ContextProbe),
      detailHostId ? createElement(DetailProbe, { hostId: detailHostId }) : null,
      screenProbe
    )
  )
}

function suppressRendererWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

async function renderScreen(screen: Screen, detailHostId?: string): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restore = suppressRendererWarning()
  try {
    await act(async () => {
      renderer = create(createElement(TestApp, { screen, detailHostId }))
      await Promise.resolve()
      await Promise.resolve()
    })
  } finally {
    restore()
  }
  if (!renderer) {
    throw new Error('settings lifecycle harness did not render')
  }
  return renderer
}

async function navigate(
  renderer: ReactTestRenderer,
  screen: Screen,
  detailHostId?: string
): Promise<void> {
  await act(async () => {
    renderer.update(createElement(TestApp, { screen, detailHostId }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function activeHostIds(): string[] {
  if (!context) {
    throw new Error('client context was not captured')
  }
  return context
    .getAllClients()
    .map(({ hostId }) => hostId)
    .sort()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  context = null
  routeFocus.effect = null
  connectMock.mockReset()
  loadHostsMock.mockReset()
})

describe('settings host client lifecycle', () => {
  it('closes settings-only clients while a mounted Home owner keeps its bounded set', async () => {
    const clients = new Map<string, FakeClient[]>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient(profile.id === 'offline-host' ? 'reconnecting' : 'connected')
      clients.set(profile.id, [...(clients.get(profile.id) ?? []), client])
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)

    function NavigationStack({ settingsVisible }: { settingsVisible: boolean }) {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          createElement(HomeProbe),
          settingsVisible ? createElement(SettingsProbe) : null
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(NavigationStack, { settingsVisible: false }))
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      restore()
    }
    if (!renderer) {
      throw new Error('navigation stack harness did not render')
    }
    expect(activeHostIds()).toEqual([...HOME_HOST_IDS].sort())
    expect(connectMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      renderer?.update(createElement(NavigationStack, { settingsVisible: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(activeHostIds()).toEqual([...HOST_IDS].sort())
    expect(connectMock).toHaveBeenCalledTimes(HOSTS.length)
    expect(loadHostsMock).toHaveBeenCalledTimes(HOME_HOST_IDS.length)

    await act(async () => {
      renderer?.update(createElement(NavigationStack, { settingsVisible: false }))
    })
    expect(activeHostIds()).toEqual([...HOME_HOST_IDS].sort())
    for (const hostId of HOME_HOST_IDS) {
      expect(clients.get(hostId)).toHaveLength(1)
      expect(clients.get(hostId)?.[0]?.closeMock).not.toHaveBeenCalled()
    }
    for (const hostId of ['folder-workspace-host', 'offline-host']) {
      expect(clients.get(hostId)?.[0]?.closeMock).toHaveBeenCalledOnce()
    }

    await act(async () => {
      renderer?.update(createElement(NavigationStack, { settingsVisible: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(loadHostsMock).toHaveBeenCalledTimes(HOME_HOST_IDS.length)
    await act(async () => {
      renderer?.update(createElement(NavigationStack, { settingsVisible: false }))
    })
    expect(activeHostIds()).toEqual([...HOME_HOST_IDS].sort())
    for (const hostId of HOME_HOST_IDS) {
      expect(clients.get(hostId)).toHaveLength(1)
    }
    for (const hostId of ['folder-workspace-host', 'offline-host']) {
      expect(clients.get(hostId)).toHaveLength(2)
      expect(clients.get(hostId)?.every((client) => client.closeMock.mock.calls.length === 1)).toBe(
        true
      )
    }

    act(() => renderer.unmount())
  })

  it('leaves no zero-reference clients after repeated settings navigation', async () => {
    const clients = new Map<string, FakeClient[]>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient('reconnecting')
      clients.set(profile.id, [...(clients.get(profile.id) ?? []), client])
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)

    const renderer = await renderScreen('settings')
    expect(activeHostIds()).toEqual([...HOST_IDS].sort())

    await navigate(renderer, 'empty')
    expect(activeHostIds()).toEqual([])
    for (const hostClients of clients.values()) {
      expect(hostClients).toHaveLength(1)
      expect(hostClients[0]?.closeMock).toHaveBeenCalledOnce()
    }

    await navigate(renderer, 'settings')
    await navigate(renderer, 'empty')
    expect(activeHostIds()).toEqual([])
    expect(connectMock).toHaveBeenCalledTimes(HOSTS.length * 2)
    for (const hostClients of clients.values()) {
      expect(hostClients).toHaveLength(2)
      expect(hostClients.every((client) => client.closeMock.mock.calls.length === 1)).toBe(true)
    }

    act(() => renderer.unmount())
  })

  it('reconciles host-list changes without restarting retained or shared clients', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient('reconnecting')
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)

    const retainedHostId = 'direct-recent'
    const sharedHostId = 'relay-recent'
    const removedHostId = 'folder-workspace-host'
    const addedHostId = 'offline-host'
    function HostListApp({ settingsHostIds }: { settingsHostIds: string[] }) {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          createElement(DetailProbe, { hostId: sharedHostId }),
          createElement(DynamicSettingsProbe, { hostIds: settingsHostIds })
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(HostListApp, {
            settingsHostIds: [retainedHostId, sharedHostId, removedHostId]
          })
        )
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      restore()
    }
    if (!renderer) {
      throw new Error('host-list lifecycle harness did not render')
    }

    await act(async () => {
      renderer?.update(
        createElement(HostListApp, {
          settingsHostIds: [retainedHostId, addedHostId]
        })
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(connectMock).toHaveBeenCalledTimes(4)
    expect(activeHostIds()).toEqual([addedHostId, retainedHostId, sharedHostId].sort())
    expect(clients.get(retainedHostId)?.closeMock).not.toHaveBeenCalled()
    expect(clients.get(sharedHostId)?.closeMock).not.toHaveBeenCalled()
    expect(clients.get(removedHostId)?.closeMock).toHaveBeenCalledOnce()
    expect(clients.get(addedHostId)?.closeMock).not.toHaveBeenCalled()

    act(() => renderer.unmount())
    expect(clients.get(retainedHostId)?.closeMock).toHaveBeenCalledOnce()
    expect(clients.get(sharedHostId)?.closeMock).toHaveBeenCalledOnce()
    expect(clients.get(addedHostId)?.closeMock).toHaveBeenCalledOnce()
  })

  it('does not close a settings client still held by an active consumer', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient('connected')
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)

    const detailHostId = 'folder-workspace-host'
    const renderer = await renderScreen('settings', detailHostId)
    await navigate(renderer, 'home', detailHostId)

    expect(activeHostIds()).toEqual([...HOME_HOST_IDS, detailHostId].sort())
    expect(clients.get(detailHostId)?.closeMock).not.toHaveBeenCalled()

    act(() => renderer.unmount())
    expect(clients.get(detailHostId)?.closeMock).toHaveBeenCalledOnce()
  })

  it('keeps a reconnect alive when another consumer remains after settings leaves', async () => {
    const retryHost = host('ssh-retry-host', 1)
    let resolveInitial: ((hosts: HostProfile[]) => void) | null = null
    let resolveRetry: ((hosts: HostProfile[]) => void) | null = null
    const initialLookup = new Promise<HostProfile[]>((resolve) => {
      resolveInitial = resolve
    })
    const retryLookup = new Promise<HostProfile[]>((resolve) => {
      resolveRetry = resolve
    })
    loadHostsMock.mockReturnValueOnce(initialLookup).mockReturnValueOnce(retryLookup)
    const initialClient = makeFakeClient('connected')
    const retryClient = makeFakeClient('reconnecting')
    connectMock.mockReturnValueOnce(initialClient).mockReturnValueOnce(retryClient)

    function RetrySettingsProbe(): null {
      useAllHostClients([retryHost.id], {
        closeUnusedOnRelease: true
      })
      return null
    }
    function RetryApp({ settingsVisible }: { settingsVisible: boolean }): React.JSX.Element {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          createElement(DetailProbe, { hostId: retryHost.id }),
          settingsVisible ? createElement(RetrySettingsProbe) : null
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      act(() => {
        renderer = create(createElement(RetryApp, { settingsVisible: true }))
      })
    } finally {
      restore()
    }
    if (!renderer || !resolveInitial || !resolveRetry) {
      throw new Error('retry lifecycle harness did not initialize')
    }
    await act(async () => {
      resolveInitial?.([retryHost])
      await initialLookup
    })
    if (!context) {
      throw new Error('client context was not captured')
    }

    const reconnect = context.forceReconnect(retryHost.id)
    expect(initialClient.closeMock).toHaveBeenCalledOnce()
    act(() => renderer?.update(createElement(RetryApp, { settingsVisible: false })))
    await act(async () => {
      resolveRetry?.([retryHost])
      await retryLookup
      await reconnect
    })

    expect(activeHostIds()).toEqual([retryHost.id])
    expect(retryClient.closeMock).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
    expect(retryClient.closeMock).toHaveBeenCalledOnce()
  })

  it('cancels a released open without cancelling a rapid replacement acquisition', async () => {
    const settingsOnlyHost = host('settings-only-offline', 0, {
      deviceToken: '',
      publicKeyB64: ''
    })
    let resolveFirst: ((hosts: HostProfile[]) => void) | null = null
    let resolveSecond: ((hosts: HostProfile[]) => void) | null = null
    const firstLookup = new Promise<HostProfile[]>((resolve) => {
      resolveFirst = resolve
    })
    const secondLookup = new Promise<HostProfile[]>((resolve) => {
      resolveSecond = resolve
    })
    loadHostsMock.mockReturnValueOnce(firstLookup).mockReturnValueOnce(secondLookup)
    const client = makeFakeClient('reconnecting')
    connectMock.mockReturnValue(client)

    function PendingSettingsProbe(): null {
      useAllHostClients([settingsOnlyHost.id], {
        closeUnusedOnRelease: true
      })
      return null
    }
    function PendingApp({ visible }: { visible: boolean }): React.JSX.Element {
      return createElement(
        RpcClientProvider,
        null,
        visible ? createElement(PendingSettingsProbe) : null
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      act(() => {
        renderer = create(createElement(PendingApp, { visible: true }))
      })
    } finally {
      restore()
    }
    if (!renderer || !resolveFirst || !resolveSecond) {
      throw new Error('pending settings harness did not initialize')
    }

    act(() => renderer?.update(createElement(PendingApp, { visible: false })))
    act(() => renderer?.update(createElement(PendingApp, { visible: true })))
    await act(async () => {
      resolveFirst?.([settingsOnlyHost])
      await firstLookup
    })
    expect(connectMock).not.toHaveBeenCalled()

    await act(async () => {
      resolveSecond?.([settingsOnlyHost])
      await secondLookup
    })
    expect(connectMock).toHaveBeenCalledOnce()

    act(() => renderer?.update(createElement(PendingApp, { visible: false })))
    expect(client.closeMock).toHaveBeenCalledOnce()
    act(() => renderer?.unmount())
  })

  it('preserves Home ownership when re-pairing replaces a selected host client', async () => {
    const clients = new Map<string, FakeClient[]>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient('connected')
      clients.set(profile.id, [...(clients.get(profile.id) ?? []), client])
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)
    const replacedHostId = HOME_HOST_IDS[0]!

    function ReplacementApp({
      detailVisible,
      settingsVisible
    }: {
      detailVisible: boolean
      settingsVisible: boolean
    }): React.JSX.Element {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          createElement(HomeProbe),
          detailVisible ? createElement(DetailProbe, { hostId: replacedHostId }) : null,
          settingsVisible ? createElement(SettingsProbe) : null
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(ReplacementApp, { detailVisible: false, settingsVisible: false })
        )
        await Promise.resolve()
      })
    } finally {
      restore()
    }
    if (!renderer || !context) {
      throw new Error('replacement lifecycle harness did not initialize')
    }

    const originalClient = clients.get(replacedHostId)?.[0]
    act(() => context?.closeHost(replacedHostId))
    expect(originalClient?.closeMock).toHaveBeenCalledOnce()

    await act(async () => {
      renderer?.update(
        createElement(ReplacementApp, { detailVisible: true, settingsVisible: false })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const replacementClient = clients.get(replacedHostId)?.[1]
    expect(replacementClient).toBeDefined()

    await act(async () => {
      renderer?.update(
        createElement(ReplacementApp, { detailVisible: false, settingsVisible: true })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() =>
      renderer?.update(
        createElement(ReplacementApp, { detailVisible: false, settingsVisible: false })
      )
    )

    expect(activeHostIds()).toEqual([...HOME_HOST_IDS].sort())
    expect(replacementClient?.closeMock).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
    expect(replacementClient?.closeMock).toHaveBeenCalledOnce()
  })

  it('releases a manual host after Home demotes or stops tracking it', async () => {
    const manualHost = host('manual-relay-host', 1, { relayHostId: 'AbCdEf0123_-xyZ9' })
    const clients: FakeClient[] = []
    connectMock.mockImplementation(() => {
      const client = makeFakeClient('reconnecting')
      clients.push(client)
      return client
    })
    loadHostsMock.mockResolvedValue([manualHost])

    function ManualHomeProbe({ selected }: { selected: boolean }): null {
      useAllHostClients([manualHost.id], {
        autoConnectHostIds: selected ? [manualHost.id] : [],
        closeUnusedOnRelease: true
      })
      return null
    }
    function ManualApp({
      selected,
      homeVisible = true
    }: {
      selected: boolean
      homeVisible?: boolean
    }) {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          homeVisible ? createElement(ManualHomeProbe, { selected }) : null
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      act(() => {
        renderer = create(createElement(ManualApp, { selected: false }))
      })
    } finally {
      restore()
    }
    if (!renderer || !context) {
      throw new Error('manual connection harness did not initialize')
    }
    await act(async () => {
      await context?.forceReconnect(manualHost.id)
    })
    expect(activeHostIds()).toEqual([manualHost.id])

    await act(async () => {
      renderer?.update(createElement(ManualApp, { selected: true }))
      await Promise.resolve()
    })
    expect(activeHostIds()).toEqual([manualHost.id])

    await act(async () => {
      renderer?.update(createElement(ManualApp, { selected: false }))
      await Promise.resolve()
    })

    expect(activeHostIds()).toEqual([])
    expect(clients[0]?.closeMock).toHaveBeenCalledOnce()

    await act(async () => {
      await context?.forceReconnect(manualHost.id)
    })
    expect(activeHostIds()).toEqual([manualHost.id])
    expect(clients).toHaveLength(2)

    act(() => renderer?.update(createElement(ManualApp, { selected: false, homeVisible: false })))
    expect(activeHostIds()).toEqual([])
    expect(clients[1]?.closeMock).toHaveBeenCalledOnce()

    act(() => renderer?.unmount())
    expect(clients.every((client) => client.closeMock.mock.calls.length === 1)).toBe(true)
  })

  it('releases settings-only clients on blur while shared owners stay mounted', async () => {
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: HostProfile) => {
      const client = makeFakeClient('reconnecting')
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(HOSTS)
    const detailHostId = 'folder-workspace-host'

    function FocusStack(): React.JSX.Element {
      return createElement(
        RpcClientProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(ContextProbe),
          createElement(HomeProbe),
          createElement(DetailProbe, { hostId: detailHostId }),
          createElement(FocusedSettingsProbe)
        )
      )
    }

    let renderer: ReactTestRenderer | null = null
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(FocusStack))
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      restore()
    }
    if (!renderer || !routeFocus.effect) {
      throw new Error('settings focus harness did not initialize')
    }
    expect(activeHostIds()).toEqual([...HOME_HOST_IDS, detailHostId].sort())

    let blur: (() => void) | undefined
    await act(async () => {
      const cleanup = routeFocus.effect?.()
      if (typeof cleanup === 'function') {
        blur = cleanup
      }
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(activeHostIds()).toEqual([...HOST_IDS].sort())

    await act(async () => {
      blur?.()
      await Promise.resolve()
    })
    expect(activeHostIds()).toEqual([...HOME_HOST_IDS, detailHostId].sort())
    for (const hostId of [...HOME_HOST_IDS, detailHostId]) {
      expect(clients.get(hostId)?.closeMock).not.toHaveBeenCalled()
    }
    expect(clients.get('offline-host')?.closeMock).toHaveBeenCalledOnce()

    act(() => renderer?.unmount())
  })
})
