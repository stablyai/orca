import { performance } from 'node:perf_hooks'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelFlowControl
} from './browser-network-tunnel-stream-state'

type GrowableReceiveStream = { id: number; windowBytes: number; receiveWindowBytes: number }

/**
 * Least connection credit one DATA frame costs. The WebSocket queues cap frames as well as bytes
 * (2,048 toward the host, 4,096 toward the client), so tiny frames must not let a connection
 * window queue more frames than that: 16 MiB / 8 KiB leaves 2,048 data frames toward the client
 * and 4 MiB / 8 KiB leaves 512 toward the host, with room for control frames.
 */
export const BROWSER_NETWORK_TUNNEL_MIN_FRAME_CREDIT_BYTES = 8 * 1024

function frameCredit(bytes: number): number {
  return Math.max(bytes, BROWSER_NETWORK_TUNNEL_MIN_FRAME_CREDIT_BYTES)
}

/** A drained stream that has received nothing for this long is idle (a kept-alive socket). */
export const BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS = 1_000

type StreamGrowth = {
  // Window growth past the legacy window.
  grownBytes: number
  charged: boolean
  drained: boolean
  lastArrivalAt: number
}

/**
 * Connection-level credit shared by every stream of one tunnel. In flight, it bounds the bytes a
 * sender has queued toward its peer; receivers acknowledge on receipt, not consumption, so a
 * stalled reader cannot starve other streams. At rest, it bounds how far streams may grow their
 * receive windows past the legacy window: growth stays charged to the pool while a stream holds
 * it, so streams that stall together pin at most the pool.
 *
 * Only genuinely idle streams (drained, nothing received for BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS)
 * give their charge up, and only when another stream needs it to grow, so kept-alive sockets never
 * cost a fresh stream its speed. Granted credit cannot be revoked, so an idle stream that wakes is
 * charged again even past the pool; while the pool is overcommitted, consuming streams withhold
 * credit to shrink back toward the legacy window. Tradeoff: idle streams that wake and stall before
 * consuming can exceed the pool by the sum of their growth, which the memory budgets fail per stream.
 */
export class BrowserNetworkTunnelConnectionCredit {
  private sendCredit: number
  private receiveCredit: number
  private unacknowledgedBytes = 0
  private readonly acknowledgeThreshold: number
  private readonly sendWaiters = new Map<number, () => void>()
  // Pool left for growth; negative while woken idle streams overcommit it.
  private receiveGrowthBytes: number
  private readonly growthByStream = new Map<number, StreamGrowth>()
  private readonly window: { sendBytes: number; receiveBytes: number } | null

  constructor(
    flowControl: BrowserNetworkTunnelFlowControl,
    side: 'client' | 'session',
    private readonly now: () => number = () => performance.now()
  ) {
    const window = flowControl.connectionWindow
    this.window = !window
      ? null
      : side === 'client'
        ? { sendBytes: window.toSessionBytes, receiveBytes: window.toClientBytes }
        : { sendBytes: window.toClientBytes, receiveBytes: window.toSessionBytes }
    this.sendCredit = this.window?.sendBytes ?? Number.POSITIVE_INFINITY
    this.receiveCredit = this.window?.receiveBytes ?? Number.POSITIVE_INFINITY
    // Batch acknowledgements without ever holding back enough credit to stall the sender.
    this.acknowledgeThreshold = this.window ? Math.ceil(this.window.receiveBytes / 16) : 0
    this.receiveGrowthBytes = this.window?.receiveBytes ?? 0
  }

  /**
   * Window change to add to the consumed bytes the stream returns: growth of up to the bytes its
   * reader just consumed (doubling per round trip), or a negative shrink while the pool is
   * overcommitted. The result never exceeds consumedBytes in magnitude.
   */
  replenishReceiveWindow(
    stream: GrowableReceiveStream,
    consumedBytes: number,
    drained: boolean
  ): number {
    if (!this.window) {
      return 0
    }
    const growth = this.streamGrowth(stream.id)
    growth.drained = drained
    if (this.receiveGrowthBytes < 0) {
      // Idle streams give the pool back before an active stream gives up its window.
      this.releaseIdleGrowth(stream.id)
    }
    if (this.receiveGrowthBytes < 0 && growth.charged && growth.grownBytes > 0) {
      const shrink = Math.min(-this.receiveGrowthBytes, growth.grownBytes, consumedBytes)
      growth.grownBytes -= shrink
      this.receiveGrowthBytes += shrink
      stream.receiveWindowBytes -= shrink
      return -shrink
    }
    const wanted = Math.min(consumedBytes, stream.windowBytes - stream.receiveWindowBytes)
    if (wanted > this.receiveGrowthBytes) {
      this.releaseIdleGrowth(stream.id)
    }
    const grown = Math.max(0, Math.min(wanted, this.receiveGrowthBytes))
    if (grown > 0) {
      this.charge(growth)
      growth.grownBytes += grown
      this.receiveGrowthBytes -= grown
      stream.receiveWindowBytes += grown
    }
    return grown
  }

  /** Bytes of the next DATA frame the connection can carry now; 0 means wait for credit. */
  sendableBytes(bytes: number): number {
    return this.sendCredit < BROWSER_NETWORK_TUNNEL_MIN_FRAME_CREDIT_BYTES
      ? 0
      : Math.min(bytes, this.sendCredit)
  }

  /** Charges one DATA frame of this many bytes. */
  spend(bytes: number): void {
    this.sendCredit -= frameCredit(bytes)
  }

  /** Parks a stream until the peer acknowledges more bytes; streams resume in the order they last blocked. */
  waitForSendCredit(streamId: number, resume: () => void): void {
    this.sendWaiters.delete(streamId)
    this.sendWaiters.set(streamId, resume)
  }

  /** Drops a retired stream's send wait and returns its grown receive window to the connection. */
  forget(stream: GrowableReceiveStream): void {
    this.sendWaiters.delete(stream.id)
    const growth = this.growthByStream.get(stream.id)
    if (growth?.charged) {
      this.receiveGrowthBytes += growth.grownBytes
    }
    this.growthByStream.delete(stream.id)
    stream.receiveWindowBytes = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
  }

  /** Applies a peer acknowledgement; false means the peer violated the protocol. */
  acknowledge(bytes: number): boolean {
    if (!this.window || this.sendCredit + bytes > this.window.sendBytes) {
      return false
    }
    this.sendCredit += bytes
    for (const [streamId, resume] of Array.from(this.sendWaiters)) {
      if (this.sendCredit === 0) {
        return true
      }
      if (this.sendWaiters.get(streamId) === resume) {
        this.sendWaiters.delete(streamId)
        resume()
      }
    }
    return true
  }

  /** Records received data; null means the peer overran the window, otherwise bytes to acknowledge now. */
  receive(streamId: number, bytes: number): number | null {
    if (!this.window) {
      return 0
    }
    const charged = frameCredit(bytes)
    if (charged > this.receiveCredit) {
      return null
    }
    const growth = this.growthByStream.get(streamId)
    if (growth) {
      growth.lastArrivalAt = this.now()
      growth.drained = false
      // A woken idle stream already holds its grown credit, so it is charged even past the pool.
      this.charge(growth)
    }
    this.receiveCredit -= charged
    this.unacknowledgedBytes += charged
    if (this.unacknowledgedBytes < this.acknowledgeThreshold) {
      return 0
    }
    const acknowledged = this.unacknowledgedBytes
    this.unacknowledgedBytes = 0
    this.receiveCredit += acknowledged
    return acknowledged
  }

  private streamGrowth(streamId: number): StreamGrowth {
    let growth = this.growthByStream.get(streamId)
    if (!growth) {
      growth = { grownBytes: 0, charged: false, drained: false, lastArrivalAt: this.now() }
      this.growthByStream.set(streamId, growth)
    }
    return growth
  }

  private charge(growth: StreamGrowth): void {
    if (!growth.charged) {
      growth.charged = true
      this.receiveGrowthBytes -= growth.grownBytes
    }
  }

  private releaseIdleGrowth(exceptStreamId: number): void {
    const idleBefore = this.now() - BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS
    for (const [streamId, growth] of this.growthByStream) {
      if (
        streamId !== exceptStreamId &&
        growth.charged &&
        growth.drained &&
        growth.grownBytes > 0 &&
        growth.lastArrivalAt <= idleBefore
      ) {
        growth.charged = false
        this.receiveGrowthBytes += growth.grownBytes
      }
    }
  }
}
