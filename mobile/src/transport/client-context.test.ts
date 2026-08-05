import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState, HostProfile } from './types'
import type { RpcClient } from './rpc-client'
import {
  dropSharedHostListLoad,
  getHostListLoadRevision,
  shareHostListLoad
} from './host-list-load-sharing'

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
  useCloseHost,
  useForceReconnect,
  useHostClient,
  usePrimeHosts
} from './client-context'
import { useRpcUnresponsiveSince } from './client-context-connection-metrics'
import type { RpcApplicationResponsiveness } from './rpc-application-responsiveness'

type FakeClient = RpcClient & {
  emitState: (state: ConnectionState) => void
  closeMock: ReturnType<typeof vi.fn>
}

function makeFakeClient(initialState: ConnectionState): FakeClient {
  let state = initialState
  const listeners = new Set<(state: ConnectionState) => void>()
  const closeMock = vi.fn()
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
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
    }
  } as FakeClient
}

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

type Harness = {
  readonly hook: ReturnType<typeof useHostClient>
  readonly closeHost: (hostId: string) => void
  readonly forceReconnect: (hostId: string, host?: HostProfile) => Promise<void>
  readonly primeHosts: (hosts: HostProfile[], sourceRevision?: number) => void
  readonly unmount: () => void
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

async function renderHarness(hostId: string): Promise<Harness> {
  let hook: ReturnType<typeof useHostClient> | null = null
  let closeHost: ((hostId: string) => void) | null = null
  let forceReconnect: ((hostId: string, host?: HostProfile) => Promise<void>) | null = null
  let primeHosts: ((hosts: HostProfile[]) => void) | null = null
  let renderer: ReactTestRenderer | null = null

  function Probe(): null {
    hook = useHostClient(hostId)
    closeHost = useCloseHost()
    forceReconnect = useForceReconnect()
    primeHosts = usePrimeHosts()
    return null
  }

  const restore = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
    })
  } finally {
    restore()
  }
  if (!hook || !closeHost || !forceReconnect || !primeHosts || !renderer) {
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
    closeHost: (id) => {
      if (!closeHost) {
        throw new Error('closeHost not rendered')
      }
      closeHost(id)
    },
    forceReconnect: (id, host) => {
      if (!forceReconnect) {
        throw new Error('forceReconnect not rendered')
      }
      return forceReconnect(id, host)
    },
    primeHosts: (hosts, sourceRevision = getHostListLoadRevision()) => {
      if (!primeHosts) {
        throw new Error('primeHosts hook not rendered')
      }
      primeHosts(hosts, sourceRevision)
    },
    unmount: () => mounted.unmount()
  }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  connectMock.mockReset()
  loadHostsMock.mockReset()
  dropSharedHostListLoad()
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

    const restore = suppressReactTestRendererDeprecationWarning()
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
      restore()
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

    const restore = suppressReactTestRendererDeprecationWarning()
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
      restore()
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

    // Regression (STA-1511): closeHost deletes the entry; before the fix the
    // hook kept handing out the closed client, so mounted screens kept
    // driving requests that could never resolve.
    await act(async () => {
      harness.closeHost(HOST.id)
    })
    expect(fake.closeMock).toHaveBeenCalled()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })

  it('waits for a replacement RPC before Force Reconnect completes', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    let resolveHealthCheck: (() => void) | null = null
    const healthCheck = new Promise<void>((resolve) => {
      resolveHealthCheck = resolve
    })
    fresh.sendRequest = vi.fn(async () => {
      await healthCheck
      return { id: 'health', ok: true, result: {} }
    })
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    let completed = false
    const reconnect = harness.forceReconnect(HOST.id).then(() => {
      completed = true
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(stale.closeMock).toHaveBeenCalledOnce()
    expect(fresh.sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      {
        timeoutMs: expect.any(Number),
        budgetSpansConnect: true,
        strictDeadline: true,
        applicationHealthProbe: true
      }
    )
    expect(completed).toBe(false)

    resolveHealthCheck?.()
    await act(async () => reconnect)
    expect(completed).toBe(true)

    harness.unmount()
  })

  it('drops the stale client while Force Reconnect reloads an uncached profile', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    let resolveHosts: ((hosts: HostProfile[]) => void) | null = null
    const profileLookup = new Promise<HostProfile[]>((resolve) => {
      resolveHosts = resolve
    })
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValueOnce([HOST]).mockReturnValueOnce(profileLookup)

    const harness = await renderHarness(HOST.id)
    let reconnect: Promise<void> | null = null
    await act(async () => {
      reconnect = harness.forceReconnect(HOST.id)
      await Promise.resolve()
    })

    expect(stale.closeMock).toHaveBeenCalledOnce()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('connecting')
    expect(connectMock).toHaveBeenCalledOnce()

    await act(async () => {
      resolveHosts?.([HOST])
      await reconnect!
    })
    expect(harness.hook.client).toBe(fresh)
    harness.unmount()
  })

  it('drops a stalled shared host lookup before opening a Force Reconnect replacement', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])
    const parked = new Promise<HostProfile[]>(() => {})
    const sharedLoad = vi.fn().mockReturnValueOnce(parked).mockResolvedValueOnce([HOST])
    const parkedLookup = shareHostListLoad(sharedLoad)

    const harness = await renderHarness(HOST.id)
    harness.primeHosts([HOST])
    await act(async () => harness.forceReconnect(HOST.id))

    expect(shareHostListLoad(sharedLoad)).not.toBe(parkedLookup)
    expect(sharedLoad).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('reconnects with relay metadata published by the endpoint lifecycle', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    const relayHostId = 'AbCdEf0123_-xyZ9'
    const upgradedHost: HostProfile = {
      ...HOST,
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.invalid/v1/connect/host' }
      ],
      relayHostId,
      relay: {
        v: 1,
        directorUrl: 'https://relay.invalid',
        cellUrl: 'https://relay.invalid',
        assignmentEpoch: 1,
        relayHostId,
        e2eeFraming: 2
      }
    }
    const publishHostUpdate = connectMock.mock.calls[0]?.[2] as
      | ((host: HostProfile) => void)
      | undefined
    publishHostUpdate?.(upgradedHost)

    await act(async () => harness.forceReconnect(HOST.id))

    expect(connectMock.mock.calls[1]?.[0]).toEqual(upgradedHost)
    expect(fresh.sendRequest).toHaveBeenCalledOnce()
    harness.unmount()
  })

  it('ignores relay metadata published by a superseded lifecycle', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    const updatedHost = { ...HOST, endpoint: 'ws://127.0.0.1:2' }
    harness.primeHosts([updatedHost])
    const publishHostUpdate = connectMock.mock.calls[0]?.[2] as
      | ((host: HostProfile) => void)
      | undefined
    publishHostUpdate?.({
      ...HOST,
      endpoints: [{ id: 'direct-primary', kind: 'lan', url: HOST.endpoint }]
    })

    await act(async () => harness.forceReconnect(HOST.id))

    expect(connectMock.mock.calls[1]?.[0]).toEqual(updatedHost)
    harness.unmount()
  })

  it('reconnects with an explicit saved profile after stale snapshot priming is rejected', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    const staleSourceRevision = getHostListLoadRevision()
    dropSharedHostListLoad()
    // Why: the primed endpoint must differ from the saved profile — with equal
    // values this test passes whether stale priming was rejected or adopted.
    const stalePrimedHost = { ...HOST, endpoint: 'ws://127.0.0.1:9' }
    const savedHost = { ...HOST, endpoint: 'ws://127.0.0.1:2' }
    harness.primeHosts([stalePrimedHost], staleSourceRevision)

    await act(async () => harness.forceReconnect(HOST.id, savedHost))

    expect(connectMock.mock.calls[1]?.[0]).toEqual(savedHost)
    harness.unmount()
  })

  it('re-renders unresponsive subscribers on latch and recovery without polling', async () => {
    const client = makeFakeClient('connected')
    connectMock.mockReturnValue(client)
    loadHostsMock.mockResolvedValue([HOST])

    let observed: number | null = null
    function UnresponsiveProbe(): null {
      useHostClient(HOST.id)
      observed = useRpcUnresponsiveSince(HOST.id)
      return null
    }
    const restore = suppressReactTestRendererDeprecationWarning()
    let renderer: ReactTestRenderer | null = null
    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(UnresponsiveProbe)))
      })
    } finally {
      restore()
    }
    expect(observed).toBeNull()

    // Why: the responsiveness instance handed to the transport is the context's
    // own — latching it must re-render metric subscribers with no timers.
    const responsiveness = connectMock.mock.calls[0]?.[3] as RpcApplicationResponsiveness
    await act(async () => {
      responsiveness.recordTimeout(4242)
    })
    expect(observed).toBe(4242)

    await act(async () => {
      responsiveness.recordApplicationResponse()
    })
    expect(observed).toBeNull()
    ;(renderer as unknown as ReactTestRenderer).unmount()
  })

  it('supersedes a pending old-profile open when Force Reconnect uses a saved endpoint', async () => {
    let resolveOldLookup: ((hosts: HostProfile[]) => void) | null = null
    const oldLookup = new Promise<HostProfile[]>((resolve) => {
      resolveOldLookup = resolve
    })
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    loadHostsMock.mockReturnValue(oldLookup)
    connectMock.mockReturnValue(fresh)

    const harness = await renderHarness(HOST.id)
    const updatedHost = { ...HOST, endpoint: 'ws://127.0.0.1:2' }
    harness.primeHosts([updatedHost])
    await act(async () => harness.forceReconnect(HOST.id))

    expect(connectMock).toHaveBeenCalledOnce()
    expect(connectMock.mock.calls[0]?.[0]).toEqual(updatedHost)

    await act(async () => {
      resolveOldLookup?.([HOST])
      await oldLookup
    })
    expect(connectMock).toHaveBeenCalledOnce()
    harness.unmount()
  })

  it('publishes lifecycle updates after cold-start priming races the host lookup', async () => {
    let resolveLookup: ((hosts: HostProfile[]) => void) | null = null
    const lookup = new Promise<HostProfile[]>((resolve) => {
      resolveLookup = resolve
    })
    const initial = makeFakeClient('connected')
    const fresh = makeFakeClient('connected')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    loadHostsMock.mockReturnValue(lookup)
    connectMock.mockReturnValueOnce(initial).mockReturnValueOnce(fresh)

    const harness = await renderHarness(HOST.id)
    harness.primeHosts([HOST])
    await act(async () => {
      resolveLookup?.([HOST])
      await lookup
    })
    const relayHostId = 'AbCdEf0123_-xyZ9'
    const upgradedHost: HostProfile = {
      ...HOST,
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.invalid/v1/connect/host' }
      ],
      relayHostId,
      relay: {
        v: 1,
        directorUrl: 'https://relay.invalid',
        cellUrl: 'https://relay.invalid',
        assignmentEpoch: 1,
        relayHostId,
        e2eeFraming: 2
      }
    }
    const publishHostUpdate = connectMock.mock.calls[0]?.[2] as
      | ((host: HostProfile) => void)
      | undefined
    publishHostUpdate?.(upgradedHost)

    await act(async () => harness.forceReconnect(HOST.id))

    expect(connectMock.mock.calls[1]?.[0]).toEqual(upgradedHost)
    harness.unmount()
  })

  it('ignores a cancelled lookup failure after its replacement connects', async () => {
    let rejectLookup: ((error: Error) => void) | null = null
    const lookup = new Promise<HostProfile[]>((_resolve, reject) => {
      rejectLookup = reject
    })
    const fresh = makeFakeClient('connected')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    loadHostsMock.mockReturnValue(lookup)
    connectMock.mockReturnValue(fresh)

    const harness = await renderHarness(HOST.id)
    harness.primeHosts([HOST])
    await act(async () => harness.forceReconnect(HOST.id))
    await act(async () => {
      rejectLookup?.(new Error('keychain locked'))
      await lookup.catch(() => undefined)
    })

    expect(harness.hook.client).toBe(fresh)
    expect(harness.hook.state).toBe('connected')
    harness.unmount()
  })

  it('coalesces overlapping Force Reconnect calls for one host', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    let resolveHealthCheck: (() => void) | null = null
    fresh.sendRequest = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveHealthCheck = () => resolve({ id: 'health', ok: true, result: {} })
        })
    )
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    harness.primeHosts([HOST])
    const first = harness.forceReconnect(HOST.id)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const second = harness.forceReconnect(HOST.id)

    expect(second).toBe(first)
    expect(connectMock).toHaveBeenCalledTimes(2)
    expect(stale.closeMock).toHaveBeenCalledOnce()
    expect(fresh.closeMock).not.toHaveBeenCalled()

    resolveHealthCheck?.()
    await act(async () => Promise.all([first, second]))

    harness.unmount()
  })

  it('opens a changed endpoint without waiting for a superseded host lookup', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connecting')
    fresh.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
    loadHostsMock.mockResolvedValueOnce([HOST]).mockReturnValueOnce(new Promise<never>(() => {}))
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)

    const harness = await renderHarness(HOST.id)
    void harness.forceReconnect(HOST.id)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const updatedHost = { ...HOST, endpoint: 'ws://127.0.0.1:2' }
    harness.primeHosts([updatedHost])
    await act(async () => harness.forceReconnect(HOST.id))

    expect(connectMock).toHaveBeenCalledTimes(2)
    expect(connectMock.mock.calls[1]?.[0]).toEqual(updatedHost)
    harness.unmount()
  })

  it('supersedes an older reconnect health probe immediately', async () => {
    const stale = makeFakeClient('connected')
    const oldReplacement = makeFakeClient('connecting')
    const newReplacement = makeFakeClient('connecting')
    let rejectOldHealthCheck: ((error: Error) => void) | null = null
    oldReplacement.sendRequest = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldHealthCheck = reject
        })
    )
    oldReplacement.closeMock.mockImplementation(() => {
      rejectOldHealthCheck?.(new Error('Client closed'))
    })
    newReplacement.sendRequest = vi.fn(async () => ({ id: 'new-health', ok: true, result: {} }))
    connectMock
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(oldReplacement)
      .mockReturnValueOnce(newReplacement)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    const first = harness.forceReconnect(HOST.id)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const updatedHost = { ...HOST, endpoint: 'ws://127.0.0.1:2' }
    harness.primeHosts([updatedHost])
    const second = harness.forceReconnect(HOST.id)
    expect(second).not.toBe(first)
    expect(connectMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      await Promise.all([first, second])
    })

    expect(connectMock.mock.calls[2]?.[0]).toEqual(updatedHost)
    expect(oldReplacement.closeMock).toHaveBeenCalledOnce()
    expect(newReplacement.sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      {
        timeoutMs: expect.any(Number),
        budgetSpansConnect: true,
        strictDeadline: true,
        applicationHealthProbe: true
      }
    )

    harness.unmount()
  })

  it('keeps a host disconnected when it closes during a changed-profile reconnect', async () => {
    const stale = makeFakeClient('connected')
    const oldReplacement = makeFakeClient('connecting')
    const newReplacement = makeFakeClient('connecting')
    newReplacement.sendRequest = vi.fn(async () => ({ id: 'new-health', ok: true, result: {} }))
    let rejectOldHealthCheck: ((error: Error) => void) | null = null
    oldReplacement.sendRequest = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldHealthCheck = reject
        })
    )
    oldReplacement.closeMock.mockImplementation(() => {
      rejectOldHealthCheck?.(new Error('Client closed'))
    })
    connectMock
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(oldReplacement)
      .mockReturnValueOnce(newReplacement)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    const first = harness.forceReconnect(HOST.id)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    harness.primeHosts([{ ...HOST, endpoint: 'ws://127.0.0.1:2' }])
    const queued = harness.forceReconnect(HOST.id)
    await act(async () => harness.closeHost(HOST.id))

    await act(async () => Promise.all([first, queued]))

    expect(connectMock).toHaveBeenCalledTimes(3)
    expect(oldReplacement.closeMock).toHaveBeenCalledOnce()
    expect(newReplacement.closeMock).toHaveBeenCalledOnce()
    expect(harness.hook.client).toBeNull()
    expect(harness.hook.state).toBe('disconnected')

    harness.unmount()
  })

  it('rejects Force Reconnect when a replacement client cannot open', async () => {
    const stale = makeFakeClient('connected')
    connectMock.mockReturnValue(stale)
    loadHostsMock.mockResolvedValueOnce([HOST]).mockResolvedValueOnce([])

    const harness = await renderHarness(HOST.id)
    await expect(harness.forceReconnect(HOST.id)).rejects.toThrow(
      'Unable to open a replacement connection'
    )
    expect(stale.closeMock).toHaveBeenCalledOnce()

    harness.unmount()
  })

  it('keeps a live replacement bound when Force Reconnect reports it unhealthy', async () => {
    const stale = makeFakeClient('connected')
    const fresh = makeFakeClient('connected')
    fresh.sendRequest = vi.fn(async () => {
      throw new Error('Application RPC channel is still not responding')
    })
    connectMock.mockReturnValueOnce(stale).mockReturnValueOnce(fresh)
    loadHostsMock.mockResolvedValue([HOST])

    const harness = await renderHarness(HOST.id)
    await act(async () => {
      await expect(harness.forceReconnect(HOST.id)).rejects.toThrow(
        'Application RPC channel is still not responding'
      )
    })

    // Regression: a rejected health check used to close and drop the
    // replacement, leaving a 'Disconnected' host with no retry loop and no
    // Reconnect affordance — the failure had to stay recoverable in-app.
    expect(fresh.closeMock).not.toHaveBeenCalled()
    expect(harness.hook.client).toBe(fresh)
    expect(harness.hook.state).toBe('connected')

    harness.unmount()
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
    const restore = suppressReactTestRendererDeprecationWarning()
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
      restore()
      act(() => renderer?.unmount())
    }
  })

  it('keeps Retry amber through forceReconnect instead of grey-then-amber', async () => {
    const first = makeFakeClient('connected')
    const second = makeFakeClient('connecting')
    second.sendRequest = vi.fn(async () => ({ id: 'health', ok: true, result: {} }))
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
    const restore = suppressReactTestRendererDeprecationWarning()
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
      restore()
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

    let closeHost: ((hostId: string) => void) | null = null
    let renderer: ReactTestRenderer | null = null
    function Probe(): null {
      closeHost = useCloseHost()
      useHostClient(HOST.id)
      return null
    }

    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      act(() => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
    } finally {
      restore()
    }
    expect(loadHostsMock).toHaveBeenCalledOnce()
    if (!closeHost || !resolveHosts || !renderer) {
      throw new Error('pending-open harness did not initialize')
    }

    act(() => closeHost?.(HOST.id))
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
    const restore = suppressReactTestRendererDeprecationWarning()
    try {
      act(() => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
    } finally {
      restore()
    }
    expect(loadHostsMock).toHaveBeenCalledOnce()
    act(() => renderer?.unmount())
    await act(async () => {
      resolveHosts?.([HOST])
      await hostLookup
    })

    expect(connectMock).not.toHaveBeenCalled()
  })
})
