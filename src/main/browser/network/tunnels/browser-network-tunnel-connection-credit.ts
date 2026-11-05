import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelFlowControl
} from './browser-network-tunnel-stream-state'

type GrowableReceiveStream = { id: number; windowBytes: number; receiveWindowBytes: number }

/**
 * Connection-level credit shared by every stream of one tunnel. In flight, it bounds the bytes a
 * sender has queued toward its peer; receivers acknowledge on receipt, not consumption, so a
 * stalled reader cannot starve other streams. At rest, it bounds how far streams holding unread
 * data may grow their receive windows past the legacy window. Idle streams (keep-alive sockets)
 * are not charged, so they never cost a fresh stream its speed; an idle grown stream that wakes
 * and stalls can exceed the pool by its own growth, which the memory budgets fail per stream.
 */
export class BrowserNetworkTunnelConnectionCredit {
  private sendCredit: number
  private receiveCredit: number
  private unacknowledgedBytes = 0
  private readonly acknowledgeThreshold: number
  private readonly sendWaiters = new Map<number, () => void>()
  private receiveGrowthBytes: number
  // Window growth past the legacy window, per stream; charged to the pool only while data is unread.
  private readonly grownBytes = new Map<number, number>()
  private readonly chargedStreams = new Set<number>()
  private readonly window: { sendBytes: number; receiveBytes: number } | null

  constructor(flowControl: BrowserNetworkTunnelFlowControl, side: 'client' | 'session') {
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
   * Grows a stream's receive window by up to the bytes its reader just consumed (doubling per round
   * trip), then stops charging the stream once its reader has drained everything it received.
   */
  replenishReceiveWindow(
    stream: GrowableReceiveStream,
    consumedBytes: number,
    drained: boolean
  ): number {
    const growth = Math.max(
      0,
      Math.min(
        consumedBytes,
        this.receiveGrowthBytes,
        stream.windowBytes - stream.receiveWindowBytes
      )
    )
    if (growth > 0) {
      this.chargeReceiveGrowth(stream.id)
      this.receiveGrowthBytes -= growth
      this.grownBytes.set(stream.id, (this.grownBytes.get(stream.id) ?? 0) + growth)
      this.chargedStreams.add(stream.id)
      stream.receiveWindowBytes += growth
    }
    if (drained) {
      this.releaseReceiveGrowth(stream.id)
    }
    return growth
  }

  sendableBytes(bytes: number): number {
    return Math.min(bytes, this.sendCredit)
  }

  spend(bytes: number): void {
    this.sendCredit -= bytes
  }

  /** Parks a stream until the peer acknowledges more bytes; streams resume in the order they last blocked. */
  waitForSendCredit(streamId: number, resume: () => void): void {
    this.sendWaiters.delete(streamId)
    this.sendWaiters.set(streamId, resume)
  }

  /** Drops a retired stream's send wait and returns its grown receive window to the connection. */
  forget(stream: GrowableReceiveStream): void {
    this.sendWaiters.delete(stream.id)
    this.releaseReceiveGrowth(stream.id)
    this.grownBytes.delete(stream.id)
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
    if (bytes > this.receiveCredit) {
      return null
    }
    // An idle grown stream that receives again is charged even past the pool; its window caps it.
    this.chargeReceiveGrowth(streamId)
    this.receiveCredit -= bytes
    this.unacknowledgedBytes += bytes
    if (this.unacknowledgedBytes < this.acknowledgeThreshold) {
      return 0
    }
    const acknowledged = this.unacknowledgedBytes
    this.unacknowledgedBytes = 0
    this.receiveCredit += acknowledged
    return acknowledged
  }

  private chargeReceiveGrowth(streamId: number): void {
    const grown = this.grownBytes.get(streamId)
    if (grown !== undefined && !this.chargedStreams.has(streamId)) {
      this.chargedStreams.add(streamId)
      this.receiveGrowthBytes -= grown
    }
  }

  private releaseReceiveGrowth(streamId: number): void {
    if (this.chargedStreams.delete(streamId)) {
      this.receiveGrowthBytes += this.grownBytes.get(streamId) ?? 0
    }
  }
}
