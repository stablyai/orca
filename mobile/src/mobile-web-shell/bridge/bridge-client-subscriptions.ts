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

/**
 * What a listener is handed when its stream dies under it, in the shape the native client's
 * `emitError` uses. Consumers read `type` and act on it — `host-worktree-refresh.ts` clears the flag
 * that says the event stream is live — so a stream that merely stops delivering leaves them waiting
 * on a replay that is never coming.
 */
export type BridgeStreamErrorResult = { type: 'error'; message: string; error?: unknown }

export function bridgeStreamError(message: string, error?: unknown): BridgeStreamErrorResult {
  return error === undefined ? { type: 'error', message } : { type: 'error', message, error }
}

type OpenStream = {
  onData: (result: unknown) => void
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  lastSeq: number
  unackedFrames: number
  unackedBytes: number
}

type SubscriptionsOptions = {
  /** False when the frame never left the page. */
  send: (frame: BridgeClientMessage) => boolean
  /** A binary frame with no listener or no decodable image. Neither is recoverable in place. */
  onDroppedBinaryFrame: () => void
}

/** Every stream the page opened, and the ack it owes the shell for each one. */
export class BridgeClientSubscriptions {
  private streams = new Map<string, OpenStream>()

  constructor(private readonly options: SubscriptionsOptions) {}

  get size(): number {
    return this.streams.size
  }

  has(id: string): boolean {
    return this.streams.has(id)
  }

  /** False when the `subscribe` never left the page. The shell has not heard of the stream, so
   *  nothing will ever end it: the slot goes back here and the listener is told, which is what the
   *  native client does with a subscribe it could not send. */
  open(
    id: string,
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  ): boolean {
    this.streams.set(id, { onData, onBinaryFrame, lastSeq: 0, unackedFrames: 0, unackedBytes: 0 })
    const sent = this.options.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'subscribe',
      id,
      method,
      params,
      // Asked for only when there is something to hand the frames to, so a shell that pays to
      // encode binary is one a listener is waiting on.
      ...(onBinaryFrame === undefined ? {} : { wantsBinary: true })
    })
    if (sent) {
      return true
    }
    this.streams.delete(id)
    onData(bridgeStreamError('the subscribe could not be posted to the shell'))
    return false
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

  /** The shell already retired this stream, so nothing is posted back for it. The listener is told
   *  before the record goes: frames that merely stop arriving are indistinguishable from a quiet
   *  stream, and a consumer waiting on a replay would wait for the life of the document. */
  end(id: string, message: string, error?: unknown): void {
    const stream = this.streams.get(id)
    if (stream === undefined) {
      return
    }
    this.streams.delete(id)
    stream.onData(bridgeStreamError(message, error))
  }

  /**
   * A stream the page is giving up on that the shell has not retired.
   *
   * Both halves are needed and neither implies the other. The listener is told, the way `end` tells
   * it, and the shell is asked to stop, because it is still serving a stream nothing else will
   * release: its own backstop counts unacked frames, and a stream that has gone quiet never reaches
   * it. Without the cancel the slot is held until the document goes.
   */
  abandon(id: string, message: string, error?: unknown): void {
    const stream = this.streams.get(id)
    if (stream === undefined) {
      return
    }
    this.cancel(id)
    stream.onData(bridgeStreamError(message, error))
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
   *  ahead of it would say the same thing twice. Silent, because the page asked for this one. */
  closeAll(): void {
    this.streams.clear()
  }

  /** For a shell replaced under the page: every stream it was serving died with it, and the
   *  listeners are the only ones in a position to do anything about that. */
  failAll(message: string): void {
    // Out of the ledger before any listener runs: one that resubscribes on the way down is opening
    // a stream against the shell that is arriving, and this loop must not take that one with it.
    const ended = this.streams
    this.streams = new Map()
    for (const stream of ended.values()) {
      stream.onData(bridgeStreamError(message))
    }
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
