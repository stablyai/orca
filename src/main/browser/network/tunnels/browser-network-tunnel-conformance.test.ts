import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate
} from '../../../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
  type BrowserNetworkTunnelFlowControl,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'

const TUNNEL_GENERATION = 7
const CHUNK_BYTES = 64 * 1024

describe('browser network tunnel conformance', () => {
  beforeEach(() => {
    // Keep stream scheduling real while counting only connect timeouts.
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
    expect(opcodesFor(tunnel, 'clientToSession', 1).slice(-2)).toEqual(['HalfClose', 'Close'])
    expect(destination.destroyed).toBe(true)

    await teardown(tunnel)
  })

  it('fails only the pending stream when the destination never connects', async () => {
    const tunnel = createConformanceTunnel()
    const healthy = await openStream(tunnel, 'healthy.internal')

    const pending = tunnel.client.open({ host: 'silent.internal', port: 443 })
    const rejected = expect(pending).rejects.toThrow('destination connect timed out')
    vi.advanceTimersByTime(BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS)
    await rejected

    expect(vi.getTimerCount()).toBe(0)
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    await expectStreamStillCarriesBytes(healthy)

    await teardown(tunnel)
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

  it('carries a fully grown window.v2 window of 1 KiB frames in both directions', async () => {
    const tunnel = createConformanceTunnel(BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL)
    const { duplex, destination } = await openStream(tunnel)
    const consumer = consumeDuplex(duplex, { autoSettle: false })
    const windowBytes = BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL.streamWindowBytes
    const frames = windowBytes / 1024
    const sendWindow = async (): Promise<void> => {
      for (let index = 0; index < frames; index += 1) {
        await writeChunk(duplex, new Uint8Array(1024).fill(index))
        destination.emit('data', new Uint8Array(1024).fill(index))
      }
      await settle()
    }

    // One window of settled traffic grows both receive windows from the legacy size to the maximum.
    await sendWindow()
    for (let round = 0; consumer.byteLength() < windowBytes && round < 16; round += 1) {
      consumer.settleAll()
      await settle()
    }
    consumer.settleAll()
    await settle()

    // The grown window then carries a full window of tiny frames with nothing settled.
    destination.autoSettleWrites = false
    await sendWindow()
    expect(totalBytes(destination.written)).toBe(2 * windowBytes)
    expect(consumer.byteLength()).toBe(2 * windowBytes)
    expect(tunnel.closures).toEqual([])
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()

    destination.settleWrites()
    consumer.settleAll()
    await settle()
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

function createConformanceTunnel(flowControl?: BrowserNetworkTunnelFlowControl): ConformanceTunnel {
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
    flowControl,
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
    flowControl,
    onClosed: (error) => tunnel.closures.push(error)
  })
  return tunnel
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

// Settle asynchronously, like downstream writes, to avoid re-entering the tunnel during push().
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

// events.once() would reject on the retired duplex's expected error.
function whenClosed(duplex: BrowserNetworkTunnelDuplex): Promise<void> {
  return new Promise((resolve) => duplex.once('close', resolve))
}

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

function concatBytes(chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

function totalBytes(chunks: readonly Uint8Array<ArrayBufferLike>[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
}
