import { EventEmitter } from 'node:events'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS } from './browser-network-tunnel-connection-credit'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'

const TUNNEL_GENERATION = 3
const CHUNK = new Uint8Array(64 * 1024)
const MIB = 1024 * 1024

describe('browser network tunnel flow control over a slow link', () => {
  let link: SimulatedLink | null = null

  afterEach(() => {
    link?.close()
    link = null
  })

  it('downloads at the negotiated window per round trip on a high-latency link', async () => {
    const rttMs = 90
    link = new SimulatedLink({ oneWayMs: rttMs / 2 })
    const download = link.openDownload(16 * MIB)
    await link.runUntil(download.opened)

    const startedAt = link.now
    await link.runUntil(() => download.received() === 16 * MIB)

    // The legacy 256 KiB window needs 64 round trips for 16 MiB; a 2 MiB window needs about 8.
    expect(link.now - startedAt).toBeLessThan(12 * rttMs)
    expect(link.closures).toEqual([])
  })

  it('keeps many window-filling streams within the connection window of queued bytes', async () => {
    link = new SimulatedLink({ oneWayMs: 45, toClientBytesPerMs: 10 * 1024 })
    const toClientWindow =
      BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL.connectionWindow!.toClientBytes
    const downloads = Array.from({ length: 64 }, () => link!.openDownload(4 * MIB))

    await link.runUntil(() => link!.now >= 8_000)

    // 64 streams hold 128 MiB of stream credit, twice the session's 64 MiB WebSocket queue cap.
    expect(link.peakQueuedToClientBytes).toBeGreaterThan(toClientWindow / 2)
    expect(link.peakQueuedToClientBytes).toBeLessThanOrEqual(toClientWindow + 64 * 1024)
    expect(downloads.every((download) => download.received() > 0)).toBe(true)
    expect(link.closures).toEqual([])
    expect(link.sessionClosed).toBe(false)
  })

  it('keeps many window-filling uploads within the connection window of queued bytes', async () => {
    link = new SimulatedLink({ oneWayMs: 45, toSessionBytesPerMs: 5 * 1024 })
    const toSessionWindow =
      BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL.connectionWindow!.toSessionBytes
    const uploads = Array.from({ length: 16 }, () => link!.openUpload(4 * MIB))

    await link.runUntil(() => link!.now >= 8_000)

    // 16 streams hold 32 MiB of stream credit; the client's WebSocket queue closes past 7 MiB.
    expect(link.peakQueuedToSessionBytes).toBeGreaterThan(toSessionWindow / 2)
    expect(link.peakQueuedToSessionBytes).toBeLessThanOrEqual(toSessionWindow + 64 * 1024)
    expect(uploads.every((upload) => upload.sent() > 0)).toBe(true)
    expect(link.closures).toEqual([])
    expect(link.sessionClosed).toBe(false)
  })

  it('keeps full speed for a fresh download beside idle keep-alive streams that grew', async () => {
    const rttMs = 90
    link = new SimulatedLink({ oneWayMs: rttMs / 2 })
    // Finished responses on kept-alive sockets: grown windows, open streams, no data.
    const idle = Array.from({ length: 24 }, () => link!.openDownload(4 * MIB))
    await link.runUntil(() => idle.every((download) => download.received() === 4 * MIB))
    link.idle(BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS)

    const fresh = link.openDownload(16 * MIB)
    await link.runUntil(fresh.opened)
    const startedAt = link.now
    await link.runUntil(() => fresh.received() === 16 * MIB)

    expect(link.now - startedAt).toBeLessThan(12 * rttMs)
    expect(link.closures).toEqual([])
  })

  it('throttles grown downloads that stall together instead of exhausting client memory', async () => {
    link = new SimulatedLink({ oneWayMs: 45 })
    const downloads = Array.from({ length: 16 }, () =>
      link!.openDownload(8 * MIB, { stallAfter: 4 * MIB })
    )
    await link.runToQuiet()

    // Growth is charged while a stream holds it, so stalled streams pin at most the pool.
    const toClientWindow =
      BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL.connectionWindow!.toClientBytes
    const unread = downloads.reduce((total, download) => total + download.unread(), 0)
    expect(downloads.every((download) => download.received() >= 4 * MIB)).toBe(true)
    expect(unread).toBeLessThanOrEqual(
      16 * BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES + toClientWindow
    )
    expect(link.streamErrors).toEqual([])
    expect(link.closures).toEqual([])
  })

  it('throttles grown uploads that stall together within the host retained budget', async () => {
    link = new SimulatedLink({ oneWayMs: 45 })
    const uploads = Array.from({ length: 8 }, () =>
      link!.openUpload(8 * MIB, { stallWritesAfter: 4 * MIB })
    )
    await link.runToQuiet()

    expect(uploads.every((upload) => upload.sent() >= 4 * MIB)).toBe(true)
    expect(link.streamErrors).toEqual([])
    expect(link.closures).toEqual([])
    expect(link.sessionClosed).toBe(false)
  })

  it('keeps uploads of tiny writes within the transport queue frame cap', async () => {
    link = new SimulatedLink({ oneWayMs: 45, toSessionBytesPerMs: 1024 })
    const uploads = Array.from({ length: 4 }, () =>
      link!.openUpload(4 * MIB, { chunk: new Uint8Array(1024) })
    )

    await link.runUntil(() => link!.now >= 8_000)

    // The paired transport closes the tunnel past 2,048 queued frames toward the host.
    expect(link.peakQueuedToSessionFrames).toBeGreaterThan(256)
    expect(link.peakQueuedToSessionFrames).toBeLessThanOrEqual(1_024)
    expect(uploads.every((upload) => upload.sent() > 0)).toBe(true)
    expect(link.closures).toEqual([])
  })

  it('completes an empty write without waiting for credit', async () => {
    link = new SimulatedLink({ oneWayMs: 45 })
    const socket = await link.openSocket()
    let written = false
    socket.write(new Uint8Array(0), () => {
      written = true
    })
    await link.runToQuiet()
    expect(written).toBe(true)
  })

  it('keeps stalled readers and writers within the legacy memory headroom', async () => {
    link = new SimulatedLink({ oneWayMs: 1 })
    const legacyWindow = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    const readers = Array.from({ length: 20 }, () => link!.openDownload(4 * MIB, { stalled: true }))
    const writers = Array.from({ length: 8 }, () => link!.openUpload(4 * MIB, { stalled: true }))
    await link.runUntil(
      () =>
        readers.every((download) => download.received() === legacyWindow) &&
        writers.every((upload) => upload.sent() === legacyWindow)
    )

    // Windows grow only while data is consumed, so stalled streams never pin the larger window.
    const fresh = link.openDownload(4 * MIB)
    await link.runUntil(() => fresh.received() === 4 * MIB)
    expect(link.streamErrors).toEqual([])
    expect(link.closures).toEqual([])
  })
})

type Download = { opened: () => boolean; received: () => number; unread: () => number }

type LinkDirection = {
  bytesPerMs: number
  lineFreeAt: number
  queued: { departsAt: number; bytes: number }[]
  peakQueuedBytes: number
  peakQueuedFrames: number
}

class SimulatedLink {
  now = 0
  readonly closures: Error[] = []
  readonly streamErrors: Error[] = []
  sessionClosed = false
  private readonly inFlight: { at: number; deliver: () => void }[] = []
  private readonly toClient: LinkDirection
  private readonly toSession: LinkDirection
  private sends = 0
  private readonly destinations: StreamingDestination[] = []
  private readonly releaseMemoryLease: () => void
  private readonly session: BrowserNetworkTunnelSession
  private readonly client: BrowserNetworkTunnelClient

  constructor(
    private readonly link: {
      oneWayMs: number
      toClientBytesPerMs?: number
      toSessionBytesPerMs?: number
    }
  ) {
    this.toClient = linkDirection(link.toClientBytesPerMs)
    this.toSession = linkDirection(link.toSessionBytesPerMs)
    const lease = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry().acquire('flow-control')!
    this.releaseMemoryLease = lease.release
    this.session = new BrowserNetworkTunnelSession({
      tunnelGeneration: TUNNEL_GENERATION,
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
      now: () => this.now,
      connect: () => {
        const destination = this.destinations.shift()!
        queueMicrotask(() => destination.emit('connect'))
        return destination
      },
      sendBinary: (bytes) => this.send(this.toClient, bytes, this.client),
      onClose: () => {
        this.sessionClosed = true
      }
    })
    this.client = new BrowserNetworkTunnelClient({
      tunnelGeneration: TUNNEL_GENERATION,
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
      sendBinary: (bytes) => this.send(this.toSession, bytes, this.session),
      now: () => this.now,
      outboundMemory: lease,
      onClosed: (error) => this.closures.push(error)
    })
  }

  openDownload(bytes: number, options: { stalled?: boolean; stallAfter?: number } = {}): Download {
    this.destinations.push(new StreamingDestination(bytes))
    let opened = false
    let received = 0
    let settled = 0
    const stallAfter = options.stalled ? 0 : (options.stallAfter ?? Number.POSITIVE_INFINITY)
    void this.client.open({ host: 'download.internal', port: 443 }).then((duplex) => {
      opened = true
      duplex.on('error', (error: Error) => this.streamErrors.push(error))
      duplex.on('data', (chunk: Buffer) => {
        received += chunk.byteLength
        if (settled < stallAfter) {
          settled += chunk.byteLength
          queueMicrotask(() => duplex.settleRead(chunk.byteLength))
        }
      })
    })
    return { opened: () => opened, received: () => received, unread: () => received - settled }
  }

  async openSocket(): Promise<BrowserNetworkTunnelDuplex> {
    this.destinations.push(new StreamingDestination(0))
    const opening = this.client.open({ host: 'socket.internal', port: 443 })
    await this.runUntil(() => this.inFlight.length === 0)
    return opening
  }

  openUpload(
    bytes: number,
    options: { stalled?: boolean; stallWritesAfter?: number; chunk?: Uint8Array } = {}
  ): { sent: () => number } {
    const chunk = options.chunk ?? CHUNK
    this.destinations.push(
      new StreamingDestination(0, options.stalled ? 0 : options.stallWritesAfter)
    )
    let sent = 0
    void this.client.open({ host: 'upload.internal', port: 443 }).then((duplex) => {
      duplex.on('error', (error: Error) => this.streamErrors.push(error))
      const writeNext = (): void => {
        if (sent >= bytes) {
          return
        }
        duplex.write(chunk, () => {
          sent += chunk.byteLength
          writeNext()
        })
      }
      writeNext()
    })
    return { sent: () => sent }
  }

  get peakQueuedToClientBytes(): number {
    return this.toClient.peakQueuedBytes
  }

  get peakQueuedToSessionBytes(): number {
    return this.toSession.peakQueuedBytes
  }

  get peakQueuedToSessionFrames(): number {
    return this.toSession.peakQueuedFrames
  }

  async runUntil(done: () => boolean): Promise<void> {
    for (;;) {
      await this.quiesce()
      if (done()) {
        return
      }
      const next = this.inFlight.shift()
      if (!next) {
        throw new Error('Simulated link stalled')
      }
      this.now = Math.max(this.now, next.at)
      next.deliver()
    }
  }

  /** Delivers everything in flight until no frame is left, e.g. once every stream has stalled. */
  async runToQuiet(): Promise<void> {
    for (;;) {
      await this.quiesce()
      const next = this.inFlight.shift()
      if (!next) {
        return
      }
      this.now = Math.max(this.now, next.at)
      next.deliver()
    }
  }

  /** Lets time pass with nothing on the wire. */
  idle(ms: number): void {
    this.now += ms
  }

  close(): void {
    this.client.close()
    this.session.close()
    this.releaseMemoryLease()
  }

  // Frames wait in the sender's queue until the line is free, then arrive one way later.
  private send(
    direction: LinkDirection,
    bytes: Uint8Array<ArrayBufferLike>,
    peer: { handleBinary: (bytes: Uint8Array<ArrayBufferLike>) => void }
  ): boolean {
    const departsAt =
      Math.max(this.now, direction.lineFreeAt) + bytes.byteLength / direction.bytesPerMs
    direction.lineFreeAt = departsAt
    while (direction.queued[0] && direction.queued[0].departsAt <= this.now) {
      direction.queued.shift()
    }
    direction.queued.push({ departsAt, bytes: bytes.byteLength })
    const queued = direction.queued.reduce((total, entry) => total + entry.bytes, 0)
    direction.peakQueuedBytes = Math.max(direction.peakQueuedBytes, queued)
    direction.peakQueuedFrames = Math.max(direction.peakQueuedFrames, direction.queued.length)
    const at = departsAt + this.link.oneWayMs
    this.sends += 1
    const copy = bytes.slice()
    let index = this.inFlight.length
    while (index > 0 && this.inFlight[index - 1]!.at > at) {
      index -= 1
    }
    this.inFlight.splice(index, 0, { at, deliver: () => peer.handleBinary(copy) })
    return true
  }

  private async quiesce(): Promise<void> {
    let observed: number
    do {
      observed = this.sends
      await new Promise((resolve) => setImmediate(resolve))
    } while (observed !== this.sends)
  }
}

function linkDirection(bytesPerMs = Number.POSITIVE_INFINITY): LinkDirection {
  return { bytesPerMs, lineFreeAt: 0, queued: [], peakQueuedBytes: 0, peakQueuedFrames: 0 }
}

class StreamingDestination extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  private paused = true
  private pumping = false

  private written = 0

  constructor(
    private remaining: number,
    // Bytes after which writes never complete; undefined never stalls.
    private readonly stallWritesAfter?: number
  ) {
    super()
  }

  setNoDelay(): this {
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    if (!this.pumping) {
      this.pumping = true
      queueMicrotask(() => this.pump())
    }
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    if (this.stallWritesAfter === undefined || this.written < this.stallWritesAfter) {
      this.written += bytes.byteLength
      callback?.()
    }
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  private pump(): void {
    while (!this.paused && !this.destroyed && this.remaining > 0) {
      const chunk = CHUNK.subarray(0, Math.min(CHUNK.byteLength, this.remaining))
      this.remaining -= chunk.byteLength
      this.emit('data', chunk)
    }
    this.pumping = false
  }
}
