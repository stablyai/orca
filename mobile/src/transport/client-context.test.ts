import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from './types'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const connectMock = vi.fn()
const loadHostsMock = vi.fn()

vi.mock('./rpc-client', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
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

import {
  RpcClientProvider,
  useDisconnectHostClient,
  useForceReconnect,
  useHostClient
} from './client-context'
import { useAllHostClients } from './use-all-host-clients'
import { useRelayRecoveryStatus } from './client-context-connection-metrics'
import { selectHomeAutoConnectHostIds } from './home-host-auto-connect'

type FakeClient = RpcClient & {
  emitState: (state: ConnectionState) => void
  emitPendingPath: (path: MobileConnectionPath | null) => void
  emitPairingRejected: (rejected: boolean) => void
  closeMock: ReturnType<typeof vi.fn>
}

function makeFakeClient(
  initialState: ConnectionState,
  activePath: MobileConnectionPath = 'tailscale'
): FakeClient {
  let state = initialState
  let pendingPath: MobileConnectionPath | null = null
  let pairingRejected = false
  const listeners = new Set<(state: ConnectionState) => void>()
  const pathListeners = new Set<() => void>()
  const closeMock = vi.fn()
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    getActivePath: () => activePath,
    getPendingPath: () => pendingPath,
    isPairingRejected: () => pairingRejected,
    onConnectionPathChange: (listener: () => void) => {
      pathListeners.add(listener)
      return () => pathListeners.delete(listener)
    },
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyForeground: vi.fn(),
    close: closeMock,
    closeMock,
    emitState: (next) => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    emitPendingPath: (next) => {
      pendingPath = next
      for (const listener of pathListeners) {
        listener()
      }
    },
    emitPairingRejected: (next) => {
      pairingRejected = next
      for (const listener of pathListeners) {
        listener()
      }
    }
  } as FakeClient
}

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

type Harness = {
  readonly hook: ReturnType<typeof useHostClient>
  readonly disconnectHost: (hostId: string) => void
  readonly unmount: () => void
}

async function renderHarness(hostId: string): Promise<Harness> {
  let hook: ReturnType<typeof useHostClient> | null = null
  let disconnectHost: ((hostId: string) => void) | null = null
  let renderer: ReactTestRenderer | null = null

  function Probe(): null {
    hook = useHostClient(hostId)
    disconnectHost = useDisconnectHostClient()
    return null
  }

  await act(async () => {
    renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
  })
  if (!hook || !disconnectHost || !renderer) {
    throw new Error('harness did not render')
  }
  const mounted = renderer as ReactTestRenderer
  return {
    get hook() {
      if (!hook) {
        throw new Error('hook not rendered')
      }
      return hook
    },
    disconnectHost: (id) => {
      if (!disconnectHost) {
        throw new Error('disconnectHost not rendered')
      }
      disconnectHost(id)
    },
    unmount: () => mounted.unmount()
  }
}

beforeEach(() => {
  connectMock.mockReset()
  loadHostsMock.mockReset()
})

describe('useHostClient', () => {
  it('rebinds when Expo reuses a screen between two connected cached hosts', async () => {
    const host2 = { ...HOST, id: 'host-2', name: 'Host 2' }
    const client1 = makeFakeClient('connected')
    const client2 = makeFakeClient('connected')
    connectMock.mockReturnValueOnce(client1).mockReturnValueOnce(client2)
    loadHostsMock.mockResolvedValue([HOST, host2])

    let selectedHostId = HOST.id
    let selectedClient: RpcClient | null = null
    let selectedState: ConnectionState = 'disconnected'
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      const selected = useHostClient(selectedHostId)
      selectedClient = selected.client
      selectedState = selected.state
      useHostClient(host2.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(selectedClient).toBe(client1)
      expect(selectedState).toBe('connected')

      selectedHostId = host2.id
      client2.emitState('disconnected')
      await act(async () => {
        renderer?.update(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })

      expect(selectedClient).toBe(client2)
      expect(selectedState).toBe('disconnected')
      expect(connectMock).toHaveBeenCalledTimes(2)
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('shows connecting while a reused screen resolves an uncached host', async () => {
    const client = makeFakeClient('connected')
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValueOnce([HOST]).mockReturnValueOnce(new Promise<never>(() => {}))

    let selectedHostId = HOST.id
    let renderTick = 0
    const stateByRenderTick = new Map<number, ConnectionState>()
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      stateByRenderTick.set(renderTick, useHostClient(selectedHostId).state)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(stateByRenderTick.get(0)).toBe('connected')

      // Why (S2): the unresolved-open window is amber, not grey — 'disconnected'
      // here made every host swap flash a dead host while the Keychain read ran.
      selectedHostId = 'missing-host'
      renderTick = 1
      await act(async () => {
        renderer?.update(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      expect(stateByRenderTick.get(1)).toBe('connecting')

      renderTick = 2
      await act(async () => {
        renderer?.update(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      expect(stateByRenderTick.get(2)).toBe('connecting')
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('drops the closed client when the host entry is removed', async () => {
    const fake = makeFakeClient('connected')
    connectMock.mockReturnValue(fake)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    expect(harness.hook.client).not.toBeNull()
    expect(harness.hook.state).toBe('connected')

    // Regression (STA-1511): disconnect deletes the entry; before the fix the
    // hook kept handing out the closed client, so mounted screens kept
    // driving requests that could never resolve.
    await act(async () => {
      harness.disconnectHost(HOST.id)
    })
    expect(fake.closeMock).toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })

  it('closes an ownerless reconnect after disconnect retires a mounted owner', async () => {
    const initialClient = makeFakeClient('connected')
    const replacementClient = makeFakeClient('connected')
    connectMock.mockReturnValueOnce(initialClient).mockReturnValueOnce(replacementClient)
    loadHostsMock.mockResolvedValue([HOST])
    let disconnectHost: ((hostId: string) => void) | null = null
    let reconnectHost: ((hostId: string) => Promise<void>) | null = null

    function Probe(): null {
      useAllHostClients([HOST.id], { closeUnusedOnRelease: true })
      disconnectHost = useDisconnectHostClient()
      reconnectHost = useForceReconnect()
      return null
    }
    function App({ visible }: { visible: boolean }) {
      return createElement(RpcClientProvider, null, visible ? createElement(Probe) : null)
    }

    let renderer: { update(element: ReactElement): void; unmount(): void } | null = null
    await act(async () => {
      renderer = create(createElement(App, { visible: true }))
      await Promise.resolve()
    })
    await act(async () => {
      disconnectHost?.(HOST.id)
      await reconnectHost?.(HOST.id)
    })
    act(() => renderer?.update(createElement(App, { visible: false })))

    expect(initialClient.closeMock).toHaveBeenCalledOnce()
    expect(replacementClient.closeMock).toHaveBeenCalledOnce()
    act(() => renderer?.unmount())
  })

  it('reports disconnected instead of hanging when the host id is unknown', async () => {
    loadHostsMock.mockResolvedValue([])

    const harness = await renderHarness('missing-host')
    expect(connectMock).not.toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })

  it('seeds connecting during the async open instead of flashing disconnected', async () => {
    let resolveHosts: ((hosts: (typeof HOST)[]) => void) | null = null
    const hostLookup = new Promise<(typeof HOST)[]>((resolve) => {
      resolveHosts = resolve
    })
    connectMock.mockReturnValue(makeFakeClient('connecting'))
    loadHostsMock.mockReturnValue(hostLookup)

    const states: ConnectionState[] = []
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      states.push(useHostClient(HOST.id).state)
      return null
    }
    try {
      act(() => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      expect(states.at(-1)).toBe('connecting')

      await act(async () => {
        resolveHosts?.([HOST])
        await hostLookup
      })
      expect(states.at(-1)).toBe('connecting')
      expect(states).not.toContain('disconnected')
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('keeps Retry amber through forceReconnect instead of grey-then-amber', async () => {
    const first = makeFakeClient('connected')
    const second = makeFakeClient('connecting')
    connectMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    loadHostsMock.mockResolvedValue([HOST])

    const states: ConnectionState[] = []
    let forceReconnect: ((hostId: string) => Promise<void>) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      forceReconnect = useForceReconnect()
      states.push(useHostClient(HOST.id).state)
      return null
    }
    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(states.at(-1)).toBe('connected')

      await act(async () => {
        await forceReconnect?.(HOST.id)
      })
      expect(first.closeMock).toHaveBeenCalled()
      expect(states.at(-1)).toBe('connecting')
      expect(states).not.toContain('disconnected')
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('nudges an existing Relay session instead of starting a fresh direct dial', async () => {
    const relayClient = makeFakeClient('disconnected', 'relay')
    connectMock.mockReturnValue(relayClient)
    loadHostsMock.mockResolvedValue([HOST])

    let forceReconnect: ((hostId: string) => Promise<void>) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      forceReconnect = useForceReconnect()
      useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })

      await act(async () => {
        await forceReconnect?.(HOST.id)
      })

      expect(relayClient.closeMock).not.toHaveBeenCalled()
      expect(relayClient.notifyForeground).toHaveBeenCalledWith('app-resume')
      expect(connectMock).toHaveBeenCalledOnce()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('rebuilds a pairing-rejected Relay client so re-pairing credentials are re-read', async () => {
    const rejectedRelayClient = makeFakeClient('disconnected', 'relay')
    const replacement = makeFakeClient('connecting', 'tailscale')
    connectMock.mockReturnValueOnce(rejectedRelayClient).mockReturnValueOnce(replacement)
    loadHostsMock.mockResolvedValue([HOST])

    let forceReconnect: ((hostId: string) => Promise<void>) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      forceReconnect = useForceReconnect()
      useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      act(() => rejectedRelayClient.emitPairingRejected(true))

      await act(async () => {
        await forceReconnect?.(HOST.id)
      })

      expect(rejectedRelayClient.closeMock).toHaveBeenCalled()
      expect(rejectedRelayClient.notifyForeground).not.toHaveBeenCalled()
      expect(connectMock).toHaveBeenCalledTimes(2)
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('does not open a client after the host is closed during an in-flight lookup', async () => {
    let resolveHosts: ((hosts: (typeof HOST)[]) => void) | null = null
    const hostLookup = new Promise<(typeof HOST)[]>((resolve) => {
      resolveHosts = resolve
    })
    const fake = makeFakeClient('connected')
    connectMock.mockReturnValue(fake)
    loadHostsMock.mockReturnValue(hostLookup)

    let disconnectHost: ((hostId: string) => void) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      disconnectHost = useDisconnectHostClient()
      useHostClient(HOST.id)
      return null
    }

    act(() => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
    })
    expect(loadHostsMock).toHaveBeenCalledOnce()
    if (!disconnectHost || !resolveHosts || !renderer) {
      throw new Error('pending-open harness did not initialize')
    }

    act(() => disconnectHost?.(HOST.id))
    await act(async () => {
      resolveHosts?.([HOST])
      await hostLookup
    })

    expect(connectMock).not.toHaveBeenCalled()
    expect(fake.closeMock).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('does not open a client after provider unmount during an in-flight lookup', async () => {
    let resolveHosts: ((hosts: (typeof HOST)[]) => void) | null = null
    const hostLookup = new Promise<(typeof HOST)[]>((resolve) => {
      resolveHosts = resolve
    })
    connectMock.mockReturnValue(makeFakeClient('connected'))
    loadHostsMock.mockReturnValue(hostLookup)

    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      useHostClient(HOST.id)
      return null
    }
    act(() => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
    })
    expect(loadHostsMock).toHaveBeenCalledOnce()
    act(() => renderer?.unmount())
    await act(async () => {
      resolveHosts?.([HOST])
      await hostLookup
    })

    expect(connectMock).not.toHaveBeenCalled()
  })
})

describe('useAllHostClients', () => {
  it('rerenders when Relay becomes pending without a transport-state change', async () => {
    const client = makeFakeClient('reconnecting')
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValue([HOST])
    let pendingPath: MobileConnectionPath | null | undefined
    let renderer!: ReturnType<typeof create>

    function Probe(): null {
      pendingPath = useAllHostClients([HOST.id])[0]?.pendingPath
      return null
    }

    await act(async () => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      await Promise.resolve()
    })
    expect(pendingPath).toBeNull()

    act(() => client.emitPendingPath('relay'))
    expect(pendingPath).toBe('relay')

    act(() => renderer.unmount())
  })

  it('publishes a latched pairing rejection to the screens', async () => {
    const client = makeFakeClient('reconnecting')
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValue([HOST])
    let status: { pendingPath: MobileConnectionPath | null; pairingRejected: boolean } | undefined
    let renderer!: ReturnType<typeof create>

    function Probe(): null {
      // Why: a screen holds the host client and reads the metric hooks beside it.
      useAllHostClients([HOST.id])
      status = useRelayRecoveryStatus(HOST.id)
      return null
    }

    await act(async () => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      await Promise.resolve()
    })
    act(() => client.emitPendingPath('relay'))
    expect(status).toEqual({ pendingPath: 'relay', pairingRejected: false })

    // Why: the desktop refusing the credential is a status-only change — no
    // transport state moves, so only the connection-path signal can carry it.
    act(() => client.emitPairingRejected(true))
    expect(status).toEqual({ pendingPath: 'relay', pairingRejected: true })

    act(() => renderer.unmount())
  })

  it('only opens the requested startup subset', async () => {
    const host2 = { ...HOST, id: 'host-2', name: 'Host 2' }
    connectMock.mockReturnValue(makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue([HOST, host2])

    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      useAllHostClients([HOST.id, host2.id], { autoConnectHostIds: [host2.id] })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(connectMock).toHaveBeenCalledOnce()
      expect(connectMock).toHaveBeenCalledWith(host2, expect.any(Function))
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('keeps startup connection fanout constant for a large saved-host list', async () => {
    const hosts = Array.from({ length: 1_000 }, (_, index) => ({
      ...HOST,
      id: `host-${index}`,
      name: `Host ${index}`,
      lastConnected: index
    }))
    const hostIds = hosts.map((host) => host.id)
    const autoConnectHostIds = selectHomeAutoConnectHostIds(hosts)
    connectMock.mockReturnValue(makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue(hosts)

    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      useAllHostClients(hostIds, { autoConnectHostIds })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(connectMock).toHaveBeenCalledTimes(3)
      expect(connectMock.mock.calls.map(([host]) => host.id)).toEqual([
        'host-999',
        'host-998',
        'host-997'
      ])
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('closes a demoted Home client when the recent-host set rotates', async () => {
    const hosts = [
      { ...HOST, id: 'host-a', lastConnected: 4 },
      { ...HOST, id: 'host-b', lastConnected: 3 },
      { ...HOST, id: 'host-c', lastConnected: 2 },
      { ...HOST, id: 'host-d', lastConnected: 1 }
    ]
    const clients = new Map<string, FakeClient>()
    connectMock.mockImplementation((profile: typeof HOST) => {
      const client = makeFakeClient('connected')
      clients.set(profile.id, client)
      return client
    })
    loadHostsMock.mockResolvedValue(hosts)

    let activeHostIds: string[] = []
    let renderer: ReactTestRenderer | null = null
    function Probe({ profiles }: { profiles: typeof hosts }): null {
      const hostIds = profiles.map((host) => host.id)
      activeHostIds = useAllHostClients(hostIds, {
        autoConnectHostIds: selectHomeAutoConnectHostIds(profiles),
        closeUnusedOnRelease: true
      }).map(({ hostId }) => hostId)
      return null
    }

    try {
      await act(async () => {
        renderer = create(
          createElement(RpcClientProvider, null, createElement(Probe, { profiles: hosts }))
        )
        await Promise.resolve()
      })
      expect(activeHostIds.sort()).toEqual(['host-a', 'host-b', 'host-c'])

      const rotatedHosts = hosts.map((host) =>
        host.id === 'host-d' ? { ...host, lastConnected: 5 } : host
      )
      await act(async () => {
        renderer?.update(
          createElement(RpcClientProvider, null, createElement(Probe, { profiles: rotatedHosts }))
        )
        await Promise.resolve()
      })

      expect(connectMock).toHaveBeenCalledTimes(4)
      expect(activeHostIds.sort()).toEqual(['host-a', 'host-b', 'host-d'])
      expect(clients.get('host-a')?.closeMock).not.toHaveBeenCalled()
      expect(clients.get('host-b')?.closeMock).not.toHaveBeenCalled()
      expect(clients.get('host-c')?.closeMock).toHaveBeenCalledOnce()
      expect(clients.get('host-d')?.closeMock).not.toHaveBeenCalled()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('retains connect-all behavior when no startup subset is provided', async () => {
    const host2 = { ...HOST, id: 'host-2', name: 'Host 2' }
    connectMock.mockReturnValue(makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue([HOST, host2])

    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      useAllHostClients([HOST.id, host2.id])
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(connectMock).toHaveBeenCalledTimes(2)
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('allows an excluded host to connect manually', async () => {
    connectMock.mockReturnValue(makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue([HOST])

    let reconnect: ((hostId: string) => Promise<void>) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      useAllHostClients([HOST.id], { autoConnectHostIds: [] })
      reconnect = useForceReconnect()
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      expect(connectMock).not.toHaveBeenCalled()
      if (!reconnect) {
        throw new Error('reconnect harness did not initialize')
      }
      await act(async () => {
        await reconnect?.(HOST.id)
      })
      expect(connectMock).toHaveBeenCalledOnce()
    } finally {
      act(() => renderer?.unmount())
    }
  })
})
