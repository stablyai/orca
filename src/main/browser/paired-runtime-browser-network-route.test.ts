import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks,
  RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserNetworkRoute } from './paired-runtime-browser-network-route'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const pairing = {
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'device-a',
  scope: 'runtime'
} as PairingOffer

const lease = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 3
}

afterEach(() => {
  subscribeRemoteRuntimeRequestMock.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('PairedRuntimeBrowserNetworkRoute', () => {
  it('closes a subscription that resolves after route teardown', async () => {
    let resolveSubscription = (_subscription: RemoteRuntimeSubscription): void => {}
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubscription = resolve
      })
    )
    const route = new PairedRuntimeBrowserNetworkRoute({
      pairing,
      lease,
      executionHostRevision: 1
    })

    const starting = route.start()
    await route.close()
    resolveSubscription({
      requestId: 'late-subscription',
      close: closeSubscription,
      sendBinary: () => true
    })

    await expect(starting).rejects.toThrow('closed during startup')
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('settles startup when close follows subscription acquisition before readiness', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'waiting-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const route = createRoute()
    const starting = route.start()
    const rejected = expect(starting).rejects.toThrow('closed during startup')
    await vi.waitFor(() => expect(callbacks).toBeDefined())

    await route.close(new Error('closed during startup'))

    await rejected
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('bounds the post-auth readiness wait', async () => {
    vi.useFakeTimers()
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValueOnce({
      requestId: 'silent-subscription',
      close: closeSubscription,
      sendBinary: () => true
    })
    const route = createRoute({ timeoutMs: 25 })
    const starting = route.start()
    const rejected = expect(starting).rejects.toThrow('Browser tunnel attach timed out')
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('surfaces listener teardown failures', async () => {
    vi.spyOn(RemoteBrowserSocksServer.prototype, 'close').mockRejectedValueOnce(
      new Error('listener close failed')
    )
    const route = createRoute()

    await expect(route.close()).rejects.toThrow('listener close failed')
  })

  it('tears down the local route when the runtime closes the tunnel', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'runtime-closed-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const onError = vi.fn()
    const route = createRoute({ onError })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'runtime-closed-subscription',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    callbacks!.onResponse({
      id: 'runtime-closed-subscription',
      ok: true,
      result: { type: 'closed', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })

    await vi.waitFor(() => expect(closeSubscription).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser network route closed by the runtime' })
    )
  })

  it('finishes failure cleanup when reporting and listener teardown both throw', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'cleanup-failure-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const closeSocks = vi
      .spyOn(RemoteBrowserSocksServer.prototype, 'close')
      .mockRejectedValueOnce(new Error('listener close failed'))
    const route = createRoute({
      onError: () => {
        throw new Error('reporting failed')
      }
    })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'cleanup-failure-subscription',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    callbacks!.onClose?.()

    await vi.waitFor(() => expect(closeSubscription).toHaveBeenCalledOnce())
    expect(closeSocks).not.toHaveBeenCalled()
    await expect(route.close()).rejects.toThrow('listener close failed')
    expect(closeSocks).toHaveBeenCalledOnce()
  })

  it('binds and releases the exact browser-host outbound memory lease', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    let subscriptionOptions: Record<string, unknown> | undefined
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        subscriptionOptions = args[5] as Record<string, unknown>
        return { requestId: 'budgeted', close: vi.fn(), sendBinary: () => true }
      }
    )
    const route = createRoute({ outboundMemoryBudgetRegistry: registry })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())

    expect(subscriptionOptions?.outboundMemoryBudget).toBeDefined()
    expect(subscriptionOptions?.outboundQueue).toMatchObject({ maxDrainFramesPerTurn: 4 })
    expect(registry.evidence()).toMatchObject({ hosts: 1, leases: 1 })
    callbacks!.onResponse({
      id: 'budgeted',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    await route.close()
    expect(registry.evidence()).toMatchObject({ hosts: 0, leases: 0 })
  })

  it('opens no subscription when browser-host memory admission is exhausted', async () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({ processMaxLeases: 0 })
    const route = createRoute({ outboundMemoryBudgetRegistry: registry })

    await expect(route.start()).rejects.toThrow('outbound memory admission failed')
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('keeps one listener fail-closed and accepts an increasing replacement generation', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    attempts[0]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts[0]!.close).toHaveBeenCalledOnce())
    const offline = await connectSocks(address.host, address.port)
    await greetSocks(offline)
    offline.write(domainConnectRequest('offline.internal', 443))
    expect(Array.from(await readExact(offline, 10))).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
    offline.destroy()

    const reconnecting = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    const reconnectingPeer = await connectSocks(address.host, address.port)
    await greetSocks(reconnectingPeer)
    reconnectingPeer.write(domainConnectRequest('still-offline.internal', 443))
    expect(Array.from(await readExact(reconnectingPeer, 10))).toEqual([
      5, 1, 0, 1, 0, 0, 0, 0, 0, 0
    ])
    reconnectingPeer.destroy()
    ready(attempts[1]!, 8)
    await expect(reconnecting).resolves.toEqual(address)

    await route.close()
  })

  it('suspends the tunnel immediately while preserving the SOCKS listener', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    route.suspend()
    expect(attempts[0]!.close).toHaveBeenCalledOnce()
    const offline = await connectSocks(address.host, address.port)
    await greetSocks(offline)
    offline.write(domainConnectRequest('offline.internal', 443))
    expect(Array.from(await readExact(offline, 10))).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
    offline.destroy()

    const reconnecting = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    await expect(reconnecting).resolves.toEqual(address)
    await route.close()
  })

  it('reattaches with the exact existing v1 payload and capability pair', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute({
      subscription: { clientCapabilities: ['existing.optional.v1'] }
    })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting
    attempts[0]!.callbacks.onClose?.()

    const reconnecting = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    await reconnecting

    for (const attempt of attempts) {
      expect(attempt.method).toBe('network.browserTunnel')
      expect(attempt.params).toEqual({
        ...lease,
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
      })
      expect(attempt.options).toMatchObject({
        perMessageDeflate: false,
        clientCapabilities: [
          'existing.optional.v1',
          'browser.clientHost.v1',
          'network.browserTunnel.v1'
        ]
      })
    }
    await route.close()
  })

  it('keeps page-command negotiation off the independent tunnel attach', async () => {
    const attempts = mockSubscriptionAttempts()
    const commandLease = { ...lease, pageCommandProtocolVersion: 1 }
    const route = new PairedRuntimeBrowserNetworkRoute({
      pairing,
      lease: commandLease,
      executionHostRevision: 1
    })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting

    expect(attempts[0]!.params).toEqual({
      ...lease,
      executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
    })
    await route.close()
  })

  it('negotiates execution-host routing only for an SSH descriptor', async () => {
    const attempts = mockSubscriptionAttempts()
    const executionHost = {
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-epoch-a',
      connectionGeneration: 2
    }
    const route = createRoute({ executionHost })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting

    expect(attempts[0]).toMatchObject({
      method: 'network.browserTunnel',
      params: { ...lease, executionHost },
      options: {
        clientCapabilities: [
          'browser.clientHost.v1',
          'network.browserTunnel.v1',
          'network.browserTunnel.executionHosts.v1'
        ]
      }
    })
    await route.close()
  })

  it('ignores late callbacks from a superseded transport', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting
    attempts[0]!.callbacks.onClose?.()

    const reconnecting = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    await reconnecting
    attempts[0]!.callbacks.onClose?.()
    ready(attempts[0]!, 9)

    const current = await connectSocks(address.host, address.port)
    await greetSocks(current)
    current.write(domainConnectRequest('current.internal', 443))
    await vi.waitFor(() => expect(openFrames(attempts[1]!)).toHaveLength(1))
    attempts[1]!.callbacks.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 8,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(current, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

    current.destroy()
    await route.close()
  })

  it('reconnects after a current tunnel protocol failure closes the client', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    attempts[0]!.callbacks.onBinary?.(new Uint8Array([1, 2, 3]))
    await vi.waitFor(() => expect(attempts[0]!.close).toHaveBeenCalledOnce())
    const reconnecting = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    await reconnecting

    const current = await connectSocks(address.host, address.port)
    await greetSocks(current)
    current.write(domainConnectRequest('recovered.internal', 443))
    await vi.waitFor(() => expect(openFrames(attempts[1]!)).toHaveLength(1))
    attempts[1]!.callbacks.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 8,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(current, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

    current.destroy()
    await route.close()
  })

  it('rebuilds a retained route after its tunnel transport dies unprompted', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    // The tunnel attaches on its own subscription, so nothing outside the route observes this.
    attempts[0]!.callbacks.onClose?.()

    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    const recovered = await connectSocks(address.host, address.port)
    await greetSocks(recovered)
    recovered.write(domainConnectRequest('recovered.internal', 443))
    await vi.waitFor(() => expect(openFrames(attempts[1]!)).toHaveLength(1))
    attempts[1]!.callbacks.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 8,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(recovered, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

    recovered.destroy()
    await route.close()
  })

  it('recovers again after a second transport death', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    attempts[0]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    // Drive a request through the rebuilt tunnel so the first recovery has fully settled before
    // the next failure; an in-flight loop would otherwise cover both deaths by itself.
    await expectSocksRoundTrip(address, attempts[1]!, 8, 'once-recovered.internal')

    attempts[1]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts).toHaveLength(3))
    ready(attempts[2]!, 9)
    await expectSocksRoundTrip(address, attempts[2]!, 9, 'twice-recovered.internal')

    await route.close()
  })

  it('retries a failing rebuild and reports the terminal failure to the route owner', async () => {
    const attempts = mockSubscriptionAttempts()
    const onUnavailable = vi.fn()
    const route = createRoute({ onUnavailable, recoveryGraceMs: 200, recoveryRetryDelayMs: 10 })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting

    subscribeRemoteRuntimeRequestMock.mockRejectedValue(new Error('runtime unreachable'))
    attempts[0]!.callbacks.onClose?.()

    await vi.waitFor(() =>
      expect(onUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('could not be rebuilt') })
      )
    )
    expect(subscribeRemoteRuntimeRequestMock.mock.calls.length).toBeGreaterThan(2)
    await route.close()
  })

  it('abandons transport recovery once the route is suspended', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute({ recoveryGraceMs: 5_000 })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting

    attempts[0]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    attempts[1]!.callbacks.onClose?.()
    route.suspend()

    const settled = attempts.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(attempts).toHaveLength(settled)
    await route.close()
  })

  it('rejects a non-increasing replacement generation and remains retryable', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting
    attempts[0]!.callbacks.onClose?.()

    const staleReconnect = route.reconnect()
    const staleRejection = expect(staleReconnect).rejects.toThrow('generation did not advance')
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 7)
    await staleRejection

    const currentReconnect = route.reconnect()
    await vi.waitFor(() => expect(attempts).toHaveLength(3))
    ready(attempts[2]!, 8)
    await expect(currentReconnect).resolves.toBeDefined()
    await route.close()
  })

  it('fences a ready generation even when the replacement closes before its await resumes', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute()
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    await starting
    attempts[0]!.callbacks.onClose?.()

    const interrupted = route.reconnect()
    const interruptedRejection = expect(interrupted).rejects.toThrow('transport was not retained')
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    attempts[1]!.callbacks.onClose?.()
    await interruptedRejection

    const replayed = route.reconnect()
    const replayedRejection = expect(replayed).rejects.toThrow('generation did not advance')
    await vi.waitFor(() => expect(attempts).toHaveLength(3))
    ready(attempts[2]!, 8)
    await replayedRejection
    await route.close()
  })

  it('replaces the tunnel generation before recycling a bounded stream ID', async () => {
    const attempts = mockSubscriptionAttempts()
    const route = createRoute({ maxStreamIdsPerTunnel: 1 })
    const starting = route.start()
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    ready(attempts[0]!, 7)
    const address = await starting

    const first = await connectSocks(address.host, address.port)
    await greetSocks(first)
    first.write(domainConnectRequest('first.internal', 443))
    await vi.waitFor(() => expect(openFrames(attempts[0]!)).toHaveLength(1))
    attempts[0]!.callbacks.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 7,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(first, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    first.destroy()

    const second = await connectSocks(address.host, address.port)
    await greetSocks(second)
    second.write(domainConnectRequest('second.internal', 443))
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    ready(attempts[1]!, 8)
    await vi.waitFor(() => expect(openFrames(attempts[1]!)).toHaveLength(1))
    attempts[1]!.callbacks.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 8,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(second, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(
      openFrames(attempts[0]!).map((frame) => [frame.tunnelGeneration, frame.streamId])
    ).toEqual([[7, 1]])
    expect(
      openFrames(attempts[1]!).map((frame) => [frame.tunnelGeneration, frame.streamId])
    ).toEqual([[8, 1]])

    second.destroy()
    await route.close()
  })
})

function createRoute(
  overrides: {
    timeoutMs?: number
    onError?: (error: Error) => void
    onUnavailable?: (error: Error) => void
    outboundMemoryBudgetRegistry?: BrowserNetworkTunnelOutboundMemoryBudgetRegistry
    maxStreamIdsPerTunnel?: number
    subscription?: RemoteRuntimeSubscriptionOptions
    executionHost?: BrowserNetworkExecutionHost
    recoveryGraceMs?: number
    recoveryRetryDelayMs?: number
  } = {}
): PairedRuntimeBrowserNetworkRoute {
  return new PairedRuntimeBrowserNetworkRoute({
    pairing,
    lease,
    executionHostRevision: 1,
    ...overrides
  })
}

type SubscriptionAttempt = {
  method: unknown
  params: unknown
  callbacks: RemoteRuntimeSubscriptionCallbacks
  options: unknown
  close: Mock<() => void>
  sent: Uint8Array<ArrayBufferLike>[]
}

function mockSubscriptionAttempts(): SubscriptionAttempt[] {
  const attempts: SubscriptionAttempt[] = []
  subscribeRemoteRuntimeRequestMock.mockImplementation(
    async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
      const attempt: SubscriptionAttempt = {
        method: args[1],
        params: args[2],
        callbacks: args[4] as RemoteRuntimeSubscriptionCallbacks,
        options: args[5],
        close: vi.fn(),
        sent: []
      }
      attempts.push(attempt)
      return {
        requestId: `attempt-${attempts.length}`,
        close: attempt.close,
        sendBinary: (bytes) => {
          attempt.sent.push(bytes)
          return true
        }
      }
    }
  )
  return attempts
}

function ready(attempt: SubscriptionAttempt, tunnelGeneration: number): void {
  attempt.callbacks.onResponse({
    id: 'browser-route',
    ok: true,
    result: { type: 'ready', tunnelGeneration },
    _meta: { runtimeId: 'runtime-a' }
  })
}

function openFrames(attempt: SubscriptionAttempt) {
  return attempt.sent
    .map(decodeBrowserNetworkTunnelFrame)
    .filter(
      (frame): frame is NonNullable<typeof frame> =>
        frame?.opcode === BrowserNetworkTunnelOpcode.Open
    )
}

/** Opens one SOCKS connection end to end, proving the route's current tunnel actually carries it. */
async function expectSocksRoundTrip(
  address: { host: string; port: number },
  attempt: SubscriptionAttempt,
  tunnelGeneration: number,
  host: string
): Promise<void> {
  const socket = await connectSocks(address.host, address.port)
  await greetSocks(socket)
  socket.write(domainConnectRequest(host, 443))
  await vi.waitFor(() => expect(openFrames(attempt)).toHaveLength(1))
  attempt.callbacks.onBinary?.(
    encodeBrowserNetworkTunnelFrame({
      opcode: BrowserNetworkTunnelOpcode.Opened,
      tunnelGeneration,
      streamId: 1,
      payload: new Uint8Array()
    })
  )
  expect(Array.from(await readExact(socket, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  socket.destroy()
}

async function connectSocks(host: string, port: number): Promise<Socket> {
  const socket = connect(port, host)
  await once(socket, 'connect')
  return socket
}

async function greetSocks(socket: Socket): Promise<void> {
  socket.write(new Uint8Array([5, 1, 0]))
  expect(Array.from(await readExact(socket, 2))).toEqual([5, 0])
}

function domainConnectRequest(host: string, port: number): Uint8Array {
  const name = new TextEncoder().encode(host)
  const request = new Uint8Array(7 + name.byteLength)
  request.set([5, 1, 0, 3, name.byteLength], 0)
  request.set(name, 5)
  new DataView(request.buffer).setUint16(5 + name.byteLength, port, false)
  return request
}

async function readExact(socket: Socket, size: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < size) {
    const [chunk] = (await once(socket, 'data')) as [Buffer]
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const combined = Buffer.concat(chunks)
  if (combined.byteLength > size) {
    socket.unshift(combined.subarray(size))
  }
  return combined.subarray(0, size)
}
