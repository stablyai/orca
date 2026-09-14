import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'

const TUNNEL_GENERATION = 7
const CHUNK_BYTES = 64 * 1024
// The session admits this many unconnected opens at once; a leaked pending-open
// claim is invisible until an admission is refused.
const SESSION_MAX_PENDING_OPENS = 16

/**
 * Wires a real BrowserNetworkTunnelClient to a real BrowserNetworkTunnelSession over encoded
 * frames so one peer's protocol assumptions are checked against the other's implementation
 * rather than against a hand-written stub of it.
 */
describe('browser network tunnel conformance', () => {
  beforeEach(() => {
    // Only setTimeout is faked so getTimerCount() counts exactly the tunnel's connect timers
    // while node:stream keeps its real microtask and setImmediate scheduling.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries a full stream lifecycle in both directions with conserved credit', async () => {
    const tunnel = createConformanceTunnel()
    const { duplex, destination } = await openStream(tunnel)
    const consumer = consumeDuplex(duplex)

    expect(opcodesFor(tunnel, 'sessionToClient', 1)).toEqual(['Opened', 'WindowUpdate'])
    expect(opcodesFor(tunnel, 'clientToSession', 1)).toEqual(['Open', 'WindowUpdate'])
    expect(windowUpdatesFor(tunnel, 'sessionToClient', 1)).toEqual([
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    ])
    expect(windowUpdatesFor(tunnel, 'clientToSession', 1)).toEqual([
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    ])

    await writeChunk(duplex, new Uint8Array([1, 2, 3, 4, 5]))
    await settle()
    expect(concatBytes(destination.written)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(windowUpdatesFor(tunnel, 'sessionToClient', 1).slice(1)).toEqual([5])

    destination.emit('data', new Uint8Array([9, 8, 7, 6, 5, 4, 3]))
    await settle()
    expect(consumer.bytes()).toEqual(new Uint8Array([9, 8, 7, 6, 5, 4, 3]))
    expect(windowUpdatesFor(tunnel, 'clientToSession', 1).slice(1)).toEqual([7])

    duplex.end()
    await settle()
    expect(destination.ended).toBe(true)
    expect(opcodesFor(tunnel, 'clientToSession', 1)).toContain('HalfClose')

    destination.emit('end')
    await whenClosed(duplex)
    expect(consumer.ended).toBe(true)
    // Both halves are finished, so the duplex retires itself and the client closes the stream.
    expect(opcodesFor(tunnel, 'clientToSession', 1).slice(-2)).toEqual(['HalfClose', 'Close'])
    expect(destination.destroyed).toBe(true)

    await teardown(tunnel)
  })

  it('ends the client stream when the destination closes without a half-close', async () => {
    const tunnel = createConformanceTunnel()
    const { duplex, destination } = await openStream(tunnel)
    const consumer = consumeDuplex(duplex)
    destination.emit('data', new Uint8Array([1, 2, 3]))
    await settle()

    destination.emit('close')
    await whenClosed(duplex)

    expect(opcodesFor(tunnel, 'sessionToClient', 1).slice(-1)).toEqual(['Close'])
    expect(consumer.ended).toBe(true)
    expect(consumer.bytes()).toEqual(new Uint8Array([1, 2, 3]))
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()

    await teardown(tunnel)
  })

  it('refuses a stream whose destination connect throws without fencing the tunnel', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')

    tunnel.refuseNextConnect = true
    await expect(tunnel.client.open({ host: 'refused.internal', port: 443 })).rejects.toThrow(
      'destination_connect_failed'
    )

    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    expect(healthy.duplex.destroyed).toBe(false)
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
  })

  it('fails only the pending stream when the destination never connects', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')

    const pending = tunnel.client.open({ host: 'silent.internal', port: 443 })
    const rejected = expect(pending).rejects.toThrow('destination connect timed out')
    vi.advanceTimersByTime(BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS)
    await rejected

    // The client's Error frame retires the session's stream, so its own connect timer is cleared too.
    expect(vi.getTimerCount()).toBe(0)
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
  })

  it('reports the session connect timeout as a stream-scoped error', async () => {
    // The client arms its own connect timer first and would always win a shared advance, so the
    // session's timer is only observable against a raw frame peer.
    const peer = createRawFramePeerSession()
    peer.session.handleBinary(openFrame(1, 'silent.internal', 443))

    vi.advanceTimersByTime(BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS)

    expect(peer.errorsFor(1)).toEqual(['destination_connect_timeout'])
    expect(peer.onClose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    peer.session.close()
    expect(peer.aggregate.outstanding).toBe(0)
  })

  it('fails only the erroring stream when the destination breaks mid-transfer', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')
    const broken = await openStream(tunnel, 'broken.internal')
    const consumer = consumeDuplex(broken.duplex)
    broken.destination.emit('data', new Uint8Array([1, 2, 3]))
    await settle()

    broken.destination.emit('error', new Error('connection reset'))
    await whenClosed(broken.duplex)

    expect(consumer.errors.map((error) => error.message)).toEqual([
      'Browser tunnel destination failed: destination_error'
    ])
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
  })

  it('retires the destination when the client abandons a stream mid-transfer', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')
    const abandoned = await openStream(tunnel, 'abandoned.internal')
    abandoned.destination.autoSettleWrites = false
    abandoned.duplex.write(new Uint8Array(CHUNK_BYTES))
    await settle()

    abandoned.duplex.destroy()
    await whenClosed(abandoned.duplex)
    await settle()

    expect(opcodesFor(tunnel, 'clientToSession', 2)).toContain('Close')
    expect(abandoned.destination.destroyed).toBe(true)
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
  })

  it('keeps an exhausted client send window scoped to its own stream', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')
    const stalled = await openStream(tunnel, 'stalled.internal')
    stalled.destination.autoSettleWrites = false

    const windowChunks = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES / CHUNK_BYTES
    for (let index = 0; index < windowChunks; index += 1) {
      await writeChunk(stalled.duplex, new Uint8Array(CHUNK_BYTES).fill(index))
    }
    stalled.duplex.write(new Uint8Array(CHUNK_BYTES).fill(0xff))
    await settle()

    expect(totalBytes(stalled.destination.written)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
    await expectStreamStillCarriesBytes(healthy)

    stalled.destination.settleWrites()
    await settle()
    expect(totalBytes(stalled.destination.written)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES + CHUNK_BYTES
    )

    await teardown(tunnel)
  })

  it('keeps an exhausted destination send window scoped to its own stream', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')
    const stalled = await openStream(tunnel, 'stalled.internal')
    const consumer = consumeDuplex(stalled.duplex, { autoSettle: false })

    const windowChunks = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES / CHUNK_BYTES
    for (let index = 0; index <= windowChunks; index += 1) {
      stalled.destination.emit('data', new Uint8Array(CHUNK_BYTES).fill(index))
      await settle()
    }

    expect(consumer.byteLength()).toBe(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    expect(stalled.destination.paused).toBe(true)
    await expectStreamStillCarriesBytes(healthy)

    consumer.settleAll()
    await settle()
    expect(consumer.byteLength()).toBe(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES + CHUNK_BYTES)
    expect(stalled.destination.paused).toBe(false)

    await teardown(tunnel)
  })

  it('releases retained bytes still queued for a stream the client abandons', async () => {
    const tunnel = createConformanceTunnel()
    const stalled = await openStream(tunnel, 'stalled.internal')
    const consumer = consumeDuplex(stalled.duplex, { autoSettle: false })

    const windowChunks = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES / CHUNK_BYTES
    for (let index = 0; index <= windowChunks; index += 1) {
      stalled.destination.emit('data', new Uint8Array(CHUNK_BYTES).fill(index))
      await settle()
    }
    expect(consumer.byteLength()).toBe(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    expect(tunnel.aggregate.bytes).toBeGreaterThan(0)

    stalled.duplex.destroy()
    await whenClosed(stalled.duplex)
    await settle()

    expect(tunnel.aggregate.outstanding).toBe(0)
    expect(tunnel.aggregate.bytes).toBe(0)
    await teardown(tunnel)
  })

  it('answers a heartbeat from either peer without disturbing streams', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')
    const nonce = new Uint8Array([4, 2])

    tunnel.client.handleBinary(pingFrame(nonce))
    tunnel.session.handleBinary(pingFrame(nonce))
    await settle()

    expect(heartbeatFrames(tunnel, 'clientToSession')).toEqual([['Pong', nonce]])
    expect(heartbeatFrames(tunnel, 'sessionToClient')).toEqual([['Pong', nonce]])
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
  })

  it('returns the session pending-open budget for connected and refused streams alike', async () => {
    const tunnel = createConformanceTunnel()

    for (let index = 0; index < SESSION_MAX_PENDING_OPENS; index += 1) {
      const opening = tunnel.client.open({ host: `never-${index}.internal`, port: 443 })
      const rejected = expect(opening).rejects.toThrow('destination_closed_before_connect')
      tunnel.destinations.at(-1)!.emit('close')
      await rejected
    }
    for (let index = 0; index < SESSION_MAX_PENDING_OPENS; index += 1) {
      const stream = await openStream(tunnel, `cycled-${index}.internal`)
      stream.duplex.resume()
      stream.destination.emit('close')
      await whenClosed(stream.duplex)
    }

    const probes = probePendingOpenBudget(tunnel)
    await settle()
    expect(probes.refusals()).toEqual([])

    probes.release()
    await settle()
    await teardown(tunnel)
  })

  it('leaves no timer or budget claim behind when both peers tear down mid-transfer', async () => {
    const tunnel = createConformanceTunnel()
    const idle = await openStream(tunnel, 'idle.internal')
    const busy = await openStream(tunnel, 'busy.internal')
    const consumer = consumeDuplex(busy.duplex, { autoSettle: false })
    busy.destination.autoSettleWrites = false
    busy.duplex.write(new Uint8Array(CHUNK_BYTES))
    busy.destination.emit('data', new Uint8Array(CHUNK_BYTES))
    const pending = tunnel.client.open({ host: 'pending.internal', port: 443 })
    void pending.catch(() => undefined)
    await settle()
    expect(consumer.byteLength()).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await teardown(tunnel)
    expect(idle.destination.destroyed).toBe(true)
    expect(busy.destination.destroyed).toBe(true)
  })
})

type FrameDirection = 'clientToSession' | 'sessionToClient'

type RecordedFrame = {
  direction: FrameDirection
  opcode: BrowserNetworkTunnelOpcode
  streamId: number
  payload: Uint8Array<ArrayBufferLike>
}

type ConformanceTunnel = {
  client: BrowserNetworkTunnelClient
  session: BrowserNetworkTunnelSession
  destinations: FakeDestination[]
  frames: RecordedFrame[]
  closures: Error[]
  onSessionClose: Mock<() => void>
  aggregate: AggregateBudgetProbe
  memory: BrowserNetworkTunnelOutboundMemoryBudgetRegistry
  releaseMemoryLease: () => void
  refuseNextConnect: boolean
}

type OpenedStream = { duplex: BrowserNetworkTunnelDuplex; destination: FakeDestination }

/** Models node:net's contract: writes settle on a later turn, never inside `write()`. */
class FakeDestination extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  paused = false
  ended = false
  autoSettleWrites = true
  readonly written: Uint8Array<ArrayBufferLike>[] = []
  private readonly unsettled: (() => void)[] = []

  setNoDelay(): this {
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    this.written.push(bytes.slice())
    if (callback) {
      this.unsettled.push(callback)
      if (this.autoSettleWrites) {
        queueMicrotask(() => this.settleWrites())
      }
    }
    return true
  }

  settleWrites(): void {
    for (const callback of this.unsettled.splice(0)) {
      callback()
    }
  }

  end(): this {
    this.ended = true
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

type AggregateBudgetProbe = {
  claim: (bytes: number) => (() => void) | null
  readonly outstanding: number
  readonly bytes: number
}

function createAggregateBudgetProbe(): AggregateBudgetProbe {
  let outstanding = 0
  let bytes = 0
  return {
    claim: (claimed: number) => {
      outstanding += 1
      bytes += claimed
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        outstanding -= 1
        bytes -= claimed
      }
    },
    get outstanding() {
      return outstanding
    },
    get bytes() {
      return bytes
    }
  }
}

function createConformanceTunnel(): ConformanceTunnel {
  const aggregate = createAggregateBudgetProbe()
  const memory = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
  const lease = memory.acquire('conformance-host')
  if (!lease) {
    throw new Error('conformance outbound memory lease was refused')
  }
  const tunnel = {
    destinations: [] as FakeDestination[],
    frames: [] as RecordedFrame[],
    closures: [] as Error[],
    onSessionClose: vi.fn<() => void>(),
    aggregate,
    memory,
    releaseMemoryLease: lease.release,
    refuseNextConnect: false
  } as ConformanceTunnel
  tunnel.session = new BrowserNetworkTunnelSession({
    tunnelGeneration: TUNNEL_GENERATION,
    connect: () => {
      if (tunnel.refuseNextConnect) {
        tunnel.refuseNextConnect = false
        throw new Error('connect refused')
      }
      const destination = new FakeDestination()
      tunnel.destinations.push(destination)
      return destination
    },
    sendBinary: (bytes) => {
      record(tunnel, 'sessionToClient', bytes)
      tunnel.client.handleBinary(bytes)
      return true
    },
    onClose: tunnel.onSessionClose,
    claimAggregateRetainedBytes: aggregate.claim
  })
  tunnel.client = new BrowserNetworkTunnelClient({
    tunnelGeneration: TUNNEL_GENERATION,
    sendBinary: (bytes) => {
      record(tunnel, 'clientToSession', bytes)
      tunnel.session.handleBinary(bytes)
      return true
    },
    outboundMemory: lease,
    onClosed: (error) => tunnel.closures.push(error)
  })
  return tunnel
}

/** A real session driven by encoded frames, for cases the paired client would pre-empt. */
function createRawFramePeerSession() {
  const aggregate = createAggregateBudgetProbe()
  const frames: RecordedFrame[] = []
  const onClose = vi.fn<() => void>()
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: TUNNEL_GENERATION,
    connect: () => new FakeDestination(),
    sendBinary: (bytes) => {
      const frame = decodeBrowserNetworkTunnelFrame(bytes)
      if (frame) {
        frames.push({ direction: 'sessionToClient', ...frame })
      }
      return true
    },
    onClose,
    claimAggregateRetainedBytes: aggregate.claim
  })
  return {
    session,
    onClose,
    aggregate,
    errorsFor: (streamId: number) =>
      frames
        .filter(
          (frame) =>
            frame.streamId === streamId && frame.opcode === BrowserNetworkTunnelOpcode.Error
        )
        .map((frame) => new TextDecoder().decode(frame.payload))
  }
}

function record(tunnel: ConformanceTunnel, direction: FrameDirection, bytes: Uint8Array): void {
  const frame = decodeBrowserNetworkTunnelFrame(bytes)
  if (!frame) {
    throw new Error(`${direction} emitted an undecodable frame`)
  }
  tunnel.frames.push({ direction, ...frame })
}

async function openStream(
  tunnel: ConformanceTunnel,
  host = 'destination.internal'
): Promise<OpenedStream> {
  const opening = tunnel.client.open({ host, port: 443 })
  const destination = tunnel.destinations.at(-1)!
  destination.emit('connect')
  return { duplex: await opening, destination }
}

type DuplexConsumer = {
  chunks: Buffer[]
  errors: Error[]
  ended: boolean
  bytes: () => Uint8Array
  byteLength: () => number
  settleAll: () => void
}

/**
 * Mirrors the SOCKS bridge's consumer contract: reads are settled from the downstream
 * write callback, so settlement never re-enters the tunnel inside its own `push`.
 */
function consumeDuplex(
  duplex: BrowserNetworkTunnelDuplex,
  options: { autoSettle?: boolean } = {}
): DuplexConsumer {
  const consumer: DuplexConsumer = {
    chunks: [],
    errors: [],
    ended: false,
    bytes: () => new Uint8Array(Buffer.concat(consumer.chunks)),
    byteLength: () => consumer.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    settleAll: () => {
      const owed = unsettled.splice(0)
      for (const bytes of owed) {
        duplex.settleRead(bytes)
      }
    }
  }
  const unsettled: number[] = []
  duplex.on('data', (chunk: Buffer) => {
    consumer.chunks.push(chunk)
    unsettled.push(chunk.byteLength)
    if (options.autoSettle !== false) {
      queueMicrotask(() => consumer.settleAll())
    }
  })
  duplex.on('error', (error: Error) => consumer.errors.push(error))
  duplex.once('end', () => {
    consumer.ended = true
  })
  return consumer
}

function probePendingOpenBudget(tunnel: ConformanceTunnel): {
  refusals: () => string[]
  release: () => void
} {
  const failures: string[] = []
  const opened = tunnel.destinations.length
  for (let index = 0; index < SESSION_MAX_PENDING_OPENS; index += 1) {
    void tunnel.client
      .open({ host: `probe-${index}.internal`, port: 443 })
      .catch((error: Error) => failures.push(error.message))
  }
  return {
    refusals: () => failures,
    release: () => {
      for (const destination of tunnel.destinations.slice(opened)) {
        destination.emit('close')
      }
    }
  }
}

async function expectStreamStillCarriesBytes(stream: OpenedStream): Promise<void> {
  const probe = new Uint8Array([0xa1, 0xb2])
  const before = totalBytes(stream.destination.written)
  await writeChunk(stream.duplex, probe)
  await settle()
  expect(totalBytes(stream.destination.written)).toBe(before + probe.byteLength)
}

async function teardown(tunnel: ConformanceTunnel): Promise<void> {
  tunnel.client.close()
  tunnel.session.close()
  await settle()
  expect(vi.getTimerCount()).toBe(0)
  expect(tunnel.aggregate.outstanding).toBe(0)
  expect(tunnel.aggregate.bytes).toBe(0)
  expect(tunnel.memory.evidence()).toMatchObject({ claims: 0, retainedBytes: 0 })
  tunnel.releaseMemoryLease()
  expect(tunnel.memory.evidence()).toMatchObject({ hosts: 0, leases: 0 })
}

function writeChunk(duplex: BrowserNetworkTunnelDuplex, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    duplex.write(bytes, (error) => (error ? reject(error) : resolve()))
  })
}

/** node:events' once() rejects on a stream 'error', which a retired duplex legitimately emits. */
function whenClosed(duplex: BrowserNetworkTunnelDuplex): Promise<void> {
  return new Promise((resolve) => duplex.once('close', resolve))
}

/** Drains microtasks and one macrotask turn; setImmediate stays real under the fake clock. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function opcodesFor(
  tunnel: ConformanceTunnel,
  direction: FrameDirection,
  streamId: number
): string[] {
  return tunnel.frames
    .filter((frame) => frame.direction === direction && frame.streamId === streamId)
    .map((frame) => BrowserNetworkTunnelOpcode[frame.opcode]!)
}

function windowUpdatesFor(
  tunnel: ConformanceTunnel,
  direction: FrameDirection,
  streamId: number
): number[] {
  return tunnel.frames
    .filter(
      (frame) =>
        frame.direction === direction &&
        frame.streamId === streamId &&
        frame.opcode === BrowserNetworkTunnelOpcode.WindowUpdate
    )
    .map((frame) => decodeBrowserNetworkTunnelWindowUpdate(frame.payload)!)
}

function heartbeatFrames(
  tunnel: ConformanceTunnel,
  direction: FrameDirection
): [string, Uint8Array][] {
  return tunnel.frames
    .filter(
      (frame) =>
        frame.direction === direction &&
        (frame.opcode === BrowserNetworkTunnelOpcode.Ping ||
          frame.opcode === BrowserNetworkTunnelOpcode.Pong)
    )
    .map((frame) => [BrowserNetworkTunnelOpcode[frame.opcode]!, new Uint8Array(frame.payload)])
}

function pingFrame(payload: Uint8Array): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({
    opcode: BrowserNetworkTunnelOpcode.Ping,
    tunnelGeneration: TUNNEL_GENERATION,
    streamId: 0,
    payload
  })
}

function openFrame(streamId: number, host: string, port: number): Uint8Array {
  const name = new TextEncoder().encode(host)
  const payload = new Uint8Array(4 + name.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, port, false)
  view.setUint16(2, name.byteLength, false)
  payload.set(name, 4)
  return encodeBrowserNetworkTunnelFrame({
    opcode: BrowserNetworkTunnelOpcode.Open,
    tunnelGeneration: TUNNEL_GENERATION,
    streamId,
    payload
  })
}

function concatBytes(chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

function totalBytes(chunks: readonly Uint8Array<ArrayBufferLike>[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
}
