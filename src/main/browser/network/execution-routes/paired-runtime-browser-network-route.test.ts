import type { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkExecutionHost } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type { PairingOffer } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type {
  RemoteRuntimeTransportSubscription,
  RemoteRuntimeTransportSubscriptionCallbacks,
  RemoteRuntimeSubscriptionOptions
} from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserNetworkRoute } from './paired-runtime-browser-network-route'
import type { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../tunnels/browser-network-tunnel-outbound-memory-budget'

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
    // Wait for recovery to finish so the second failure exercises a new recovery loop.
    await expectSocksRoundTrip(address, attempts[1]!, 8, 'once-recovered.internal')

    attempts[1]!.callbacks.onClose?.()
    await vi.waitFor(() => expect(attempts).toHaveLength(3))
    ready(attempts[2]!, 9)
    await expectSocksRoundTrip(address, attempts[2]!, 9, 'twice-recovered.internal')

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
    connection: pairedRuntimeConnectionFromOffer(pairing),
    lease,
    executionHostRevision: 1,
    ...overrides
  })
}

type SubscriptionAttempt = {
  method: unknown
  params: unknown
  callbacks: RemoteRuntimeTransportSubscriptionCallbacks
  options: unknown
  close: Mock<() => void>
  sent: Uint8Array<ArrayBufferLike>[]
}

function mockSubscriptionAttempts(): SubscriptionAttempt[] {
  const attempts: SubscriptionAttempt[] = []
  subscribeRemoteRuntimeRequestMock.mockImplementation(
    async (
      ...args: Parameters<typeof subscribeRemoteRuntimeTransport>
    ): Promise<RemoteRuntimeTransportSubscription> => {
      const attempt: SubscriptionAttempt = {
        method: args[1],
        params: args[2],
        callbacks: args[4],
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

function ready(
  attempt: SubscriptionAttempt,
  tunnelGeneration: number,
  capabilities?: string[]
): void {
  attempt.callbacks.onResponse({
    id: 'browser-route',
    ok: true,
    result: { type: 'ready', tunnelGeneration, ...(capabilities ? { capabilities } : {}) },
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
