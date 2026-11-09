import { createElement } from 'react'

import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from './connection-state'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const push = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }))
vi.mock('../../notifications/push-registration', () => ({ attachPushRegistration: push.attach }))

// Descriptor status probes need RPC stubs these clients do not provide.
const descriptorProbe = vi.hoisted(() => {
  const stop = vi.fn()
  return {
    stop,
    start: vi.fn((_client: unknown, _onStatus: (status: unknown) => void) => stop),
    record: vi.fn()
  }
})
vi.mock('./runtime-status-probe', () => ({
  startRuntimeStatusProbe: (client: unknown, onStatus: (status: unknown) => void) =>
    descriptorProbe.start(client, onStatus)
}))
vi.mock('../hosts/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: (...args: unknown[]) => descriptorProbe.record(...args)
}))

const connectMock = vi.fn()
const loadHostsMock = vi.fn()

vi.mock('../rpc/direct-rpc-connect', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('../hosts/host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('../../diagnostics/connection/connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))
vi.mock('../../diagnostics/connection/connection-log-background-flush', () => ({
  subscribeConnectionLogBackgroundFlush: () => () => {}
}))

import { RpcClientProvider } from './client-context'
import { useDisconnectHostClient, useHostClient } from './host-client-hooks'
import { useAllHostClients } from './use-all-host-clients'
import { useRelayRecoveryStatus } from './client-context-connection-metrics'

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
  push.attach.mockReset().mockReturnValue(push.detach)
  push.detach.mockReset()
  connectMock.mockReset()
  loadHostsMock.mockReset()
})

describe('useHostClient', () => {
  it('drops the closed client when the host entry is removed', async () => {
    const fake = makeFakeClient('connected')
    connectMock.mockReturnValue(fake)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    expect(harness.hook.client).not.toBeNull()
    expect(harness.hook.state).toBe('connected')

    // Disconnect must retire the entry so mounted screens cannot reuse a permanently closed client.
    await act(async () => {
      harness.disconnectHost(HOST.id)
    })
    expect(fake.closeMock).toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
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
      // Model a screen holding its client while observing metric hooks.
      useAllHostClients([HOST.id])
      status = useRelayRecoveryStatus(HOST.id)
      return null
    }

    await act(async () => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      await Promise.resolve()
    })
    act(() => client.emitPendingPath('relay'))
    expect(status).toEqual({
      pendingPath: 'relay',
      pairingRejected: false,
      relayHostReachability: 'connecting'
    })

    // Credential refusal changes status without transport state; the path signal must carry it.
    act(() => client.emitPairingRejected(true))
    expect(status).toEqual({
      pendingPath: 'relay',
      pairingRejected: true,
      relayHostReachability: 'connecting'
    })

    act(() => renderer.unmount())
  })
})
