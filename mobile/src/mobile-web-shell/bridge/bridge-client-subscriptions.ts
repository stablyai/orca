import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { RpcEnvelopeFields } from '../../transport/rpc-envelope-fields'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeClientMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import { decodeBridgeScreencastFrame, type BridgeBinaryEvent } from './bridge-screencast-binary'

type BridgeEventMessage = Extract<BridgeHostMessage, { type: 'event' }>

export type BridgeStreamEndReason = Extract<BridgeHostMessage, { type: 'end' }>['reason']

// Acknowledge at one quarter of the shell’s 256-frame/4 MiB windows, leaving room for in-flight frames while the ack crosses.
export const BRIDGE_ACK_INTERVAL_FRAMES = 64
export const BRIDGE_ACK_INTERVAL_BYTES = 1024 * 1024

// Emit the native client’s error shape on termination so consumers stop waiting for a replay; silent streams look merely quiet.
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
  send: (frame: BridgeClientMessage) => boolean
  onDroppedBinaryFrame: () => void
}

export class BridgeClientSubscriptions {
  private streams = new Map<string, OpenStream>()

  constructor(private readonly options: SubscriptionsOptions) {}

  get size(): number {
    return this.streams.size
  }

  has(id: string): boolean {
    return this.streams.has(id)
  }

  // If subscribe never posts, release its local slot and notify the listener; the shell cannot end a stream it never heard of.
  open(
    id: string,
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    onBinaryFrame?: (frame: BrowserScreencastFrame) => void,
    envelope?: RpcEnvelopeFields
  ): boolean {
    this.streams.set(id, { onData, onBinaryFrame, lastSeq: 0, unackedFrames: 0, unackedBytes: 0 })
    const sent = this.options.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'subscribe',
      id,
      method,
      params,
      // Request binary only with a listener so native encoding is never spent on frames the page drops.
      ...(onBinaryFrame === undefined ? {} : { wantsBinary: true }),
      ...(envelope === undefined ? {} : { envelope })
    })
    if (sent) {
      return true
    }
    this.streams.delete(id)
    onData(bridgeStreamError('the subscribe could not be posted to the shell'))
    return false
  }

  deliver(message: BridgeEventMessage, bytes: number): void {
    const stream = this.streams.get(message.id)
    if (stream === undefined) {
      return
    }
    stream.lastSeq = message.seq
    stream.unackedFrames += 1
    stream.unackedBytes += bytes
    // Ack before listeners run; a listener throw must not wedge the window after a successfully read frame.
    this.ackIfDue(message.id, stream)
    if ('binary' in message) {
      this.deliverBinary(stream, message.binary)
      return
    }
    stream.onData(message.payload)
  }

  // Shell already retired this stream; notify the listener without a redundant cancel.
  end(id: string, message: string, error?: unknown): void {
    const stream = this.streams.get(id)
    if (stream === undefined) {
      return
    }
    this.streams.delete(id)
    stream.onData(bridgeStreamError(message, error))
  }

  // On local abandonment, notify the listener and cancel at the shell; a quiet stream never fills the shell’s backstop and would otherwise hold its slot forever.
  abandon(id: string, message: string, error?: unknown): void {
    const stream = this.streams.get(id)
    if (stream === undefined) {
      return
    }
    this.cancel(id)
    stream.onData(bridgeStreamError(message, error))
  }

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

  // Close authorizes shell teardown of all streams, so omit per-stream cancels and keep user-requested cleanup silent.
  closeAll(): void {
    this.streams.clear()
  }

  failAll(message: string): void {
    // Remove old records before callbacks; a listener resubscribing into the replacement must survive this teardown loop.
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
