import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import { decodeBridgeScreencastFrame, type BridgeBinaryEvent } from './bridge-screencast-binary'

type BridgeEventMessage = Extract<BridgeHostMessage, { type: 'event' }>

/** Derived from the envelope's closed list, the same way the shell's ledger derives it: a reason
 *  added there is a compile error here rather than one this side silently never sees. */
export type BridgeStreamEndReason = Extract<BridgeHostMessage, { type: 'end' }>['reason']

/**
 * How far behind the page lets itself fall before it acks.
 *
 * The shell ends a stream at 256 unacked frames or 4 MiB. A quarter of each leaves room for the
 * frames already in flight when an ack is posted, so a page that is keeping up never walks the
 * shell's window down to the point where it ends a stream. `bridge-rpc-client-frames.test.ts` pins
 * the ratio against the shell's own numbers.
 */
export const BRIDGE_ACK_INTERVAL_FRAMES = 64
export const BRIDGE_ACK_INTERVAL_BYTES = 1024 * 1024

type OpenStream = {
  onData: (result: unknown) => void
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  lastSeq: number
  unackedFrames: number
  unackedBytes: number
}

type SubscriptionsOptions = {
  send: (frame: BridgeClientMessage) => void
  /** A binary frame with no listener or no decodable image. Neither is recoverable in place. */
  onDroppedBinaryFrame: () => void
}

/** Every stream the page opened, and the ack it owes the shell for each one. */
export class BridgeClientSubscriptions {
  private readonly streams = new Map<string, OpenStream>()

  constructor(private readonly options: SubscriptionsOptions) {}

  get size(): number {
    return this.streams.size
  }

  has(id: string): boolean {
    return this.streams.has(id)
  }

  open(
    id: string,
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  ): void {
    this.streams.set(id, { onData, onBinaryFrame, lastSeq: 0, unackedFrames: 0, unackedBytes: 0 })
    this.options.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'subscribe',
      id,
      method,
      params,
      // Asked for only when there is something to hand the frames to, so a shell that pays to
      // encode binary is one a listener is waiting on.
      ...(onBinaryFrame === undefined ? {} : { wantsBinary: true })
    })
  }

  /** `bytes` is the raw frame as the shell measured it, so both sides' windows agree exactly. */
  deliver(message: BridgeEventMessage, bytes: number): void {
    const stream = this.streams.get(message.id)
    if (stream === undefined) {
      return
    }
    stream.lastSeq = message.seq
    stream.unackedFrames += 1
    stream.unackedBytes += bytes
    // Acked before the listener runs: the frame was received and read either way, and a listener
    // that throws must not also wedge the stream by stranding the ack behind it.
    this.ackIfDue(message.id, stream)
    if ('binary' in message) {
      this.deliverBinary(stream, message.binary)
      return
    }
    stream.onData(message.payload)
  }

  /** The shell already retired this stream, so nothing is posted back for it. */
  end(id: string): void {
    this.streams.delete(id)
  }

  /** The page is done with the stream. Idempotent: a second dispose posts nothing. */
  cancel(id: string): void {
    if (!this.streams.delete(id)) {
      return
    }
    this.options.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'cancel',
      id,
      target: 'subscription'
    })
  }

  /** For `close`, which is the shell's authority to tear down both sides: a cancel per stream
   *  ahead of it would say the same thing twice. */
  closeAll(): void {
    this.streams.clear()
  }

  private deliverBinary(stream: OpenStream, binary: BridgeBinaryEvent): void {
    const onBinaryFrame = stream.onBinaryFrame
    if (onBinaryFrame === undefined) {
      this.options.onDroppedBinaryFrame()
      return
    }
    const frame = decodeBridgeScreencastFrame(binary)
    if (frame === null) {
      this.options.onDroppedBinaryFrame()
      return
    }
    onBinaryFrame(frame)
  }

  private ackIfDue(id: string, stream: OpenStream): void {
    if (
      stream.unackedFrames < BRIDGE_ACK_INTERVAL_FRAMES &&
      stream.unackedBytes < BRIDGE_ACK_INTERVAL_BYTES
    ) {
      return
    }
    stream.unackedFrames = 0
    stream.unackedBytes = 0
    this.options.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'ack', id, seq: stream.lastSeq })
  }
}
