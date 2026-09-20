import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import {
  bridgeScreencastBase64Length,
  bridgeScreencastFrameHeader,
  encodeBridgeScreencastFrame
} from './bridge/bridge-screencast-encoder'
import type { BridgeBinaryEvent } from './bridge/bridge-screencast-binary'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'

/** Derived, so an arm added to the envelope's closed list is a compile error here rather than a
 *  reason this module never sends. */
export type BridgeEndReason = Extract<BridgeHostMessage, { type: 'end' }>['reason']

/**
 * Frames the page has not acked, per subscription. `postBridgeMessage` resolves on enqueue and
 * proves nothing about delivery, so a page that has stopped reading is invisible until it stops
 * acking: this window is the only evidence the shell gets, and without it a stalled page grows the
 * native queue until the process dies.
 */
export const BRIDGE_MAX_UNACKED_FRAMES = 256
export const BRIDGE_MAX_UNACKED_BYTES = 4 * 1024 * 1024

type UnackedFrame = { seq: number; bytes: number }

type OpenSubscription = {
  unsubscribe: () => void
  /** Last seq sent. Starts at 0 so `ack{seq:0}` is the honest "nothing yet". */
  seq: number
  unacked: UnackedFrame[]
  unackedBytes: number
  /** Binary frames this stream could not carry. Per stream, which is what tells a stream losing
   *  frames steadily from one that lost a single burst. */
  droppedFrames: number
}

/** A screencast frame the shell could not deliver, as the host reports it. */
export type BridgeDroppedBinaryFrame = {
  id: string
  /** The whole event frame, not the image: what was measured against the cap. */
  bytes: number
  /** On this stream, counting from its subscribe. */
  droppedOnStream: number
}

/**
 * Every host subscription the page opened, and the backpressure window each one carries.
 *
 * Ending a stream is never silent. Dropping terminal bytes to keep a stream alive corrupts a
 * transcript, which the reader cannot see; a stream that ends says so, and the page can resubscribe.
 */
export class BridgeHostSubscriptions {
  private readonly open = new Map<string, OpenSubscription>()
  private droppedTotal = 0

  constructor(
    private readonly options: {
      client: RpcClient
      /** Fire and forget: the host owns rejection logging, and no post proves delivery. */
      post: (json: string) => void
      /** One call per dropped screencast frame. The host reports it and raises the total. */
      onBinaryFrameDropped: (dropped: BridgeDroppedBinaryFrame) => void
    }
  ) {}

  get size(): number {
    return this.open.size
  }

  /**
   * Every binary frame this host could not carry, across all of its streams and their whole lives.
   *
   * A total rather than a per-stream number, because the surface that shows it is the shell's dev
   * facts and a resubscribe must not reset what it reads. The per-stream count rides the
   * diagnostic.
   */
  get droppedBinaryFrames(): number {
    return this.droppedTotal
  }

  has(id: string): boolean {
    return this.open.has(id)
  }

  /**
   * Throws whatever `client.subscribe` throws; the caller answers the page with `error`.
   *
   * `wantsBinary` is the page saying it has a listener for the screencast's `Uint8Array` frames.
   * Asked for only then, because encoding one costs the shell a base64 pass over the whole image
   * and a page with no listener would pay for frames it drops.
   */
  start(id: string, method: string, params: unknown, wantsBinary = false): void {
    const record: OpenSubscription = {
      unsubscribe: () => undefined,
      seq: 0,
      unacked: [],
      unackedBytes: 0,
      droppedFrames: 0
    }
    this.open.set(id, record)
    let unsubscribe: () => void
    try {
      unsubscribe = this.options.client.subscribe(
        method,
        params,
        (payload) => this.deliver(id, payload),
        wantsBinary ? { onBinaryFrame: (frame) => this.deliverBinaryFrame(id, frame) } : undefined
      )
    } catch (error) {
      this.open.delete(id)
      throw error
    }
    // A stream that emitted and overflowed inside `subscribe` is already retired, and its
    // unsubscribe arrived too late to be stored: calling it here is what keeps it from leaking.
    if (this.open.get(id) === record) {
      record.unsubscribe = unsubscribe
    } else {
      unsubscribe()
    }
  }

  ack(id: string, seq: number): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    let acked = 0
    for (const frame of record.unacked) {
      if (frame.seq > seq) {
        break
      }
      record.unackedBytes -= frame.bytes
      acked += 1
    }
    record.unacked.splice(0, acked)
  }

  /** `null` tears the stream down without telling the page, for a page that already said goodbye. */
  cancel(id: string, reason: BridgeEndReason | null): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    this.open.delete(id)
    try {
      record.unsubscribe()
    } catch {
      // A client whose unsubscribe throws must not keep the rest of the ledger open.
    }
    if (reason !== null) {
      this.options.post(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason }))
    }
  }

  // Deleting the visited entry is what a `Map` iterator is specified to survive, so the ledger is
  // walked in place rather than copied.
  closeAll(reason: BridgeEndReason | null): void {
    for (const id of this.open.keys()) {
      this.cancel(id, reason)
    }
  }

  private deliver(id: string, payload: unknown): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    const seq = record.seq + 1
    let json: string
    try {
      json = JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, payload })
    } catch {
      // Nothing off the wire is cyclic, but a stream that cannot be serialized ends rather than
      // silently skipping the frame the reader is missing.
      this.cancel(id, 'closed')
      return
    }
    this.sendEvent(id, record, seq, json, false)
  }

  /**
   * The screencast's binary frames, on the same ledger as the stream's JSON events.
   *
   * One `seq` sequence across both kinds, because the page acks by it: a binary frame that
   * restarted or skipped the count would ack frames the shell never sent. Nothing here can throw
   * the way an arbitrary stream payload can — every field is a number, a closed-list string or the
   * base64 image — so there is no serialization arm.
   */
  private deliverBinaryFrame(id: string, frame: BrowserScreencastFrame): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    const seq = record.seq + 1
    // Priced before it is encoded, and exactly: the header serialized plus the image's base64
    // length is the whole frame, because base64 is ASCII and JSON escapes none of it. Encoding
    // first would make a page that has stopped acking pay a full pass over every image the shell
    // then throws away — ten 300 KB frames against a closed window is 3 MB encoded and nothing
    // sent.
    const bytes =
      utf8ByteLength(this.binaryEventJson(id, seq, bridgeScreencastFrameHeader(frame))) +
      bridgeScreencastBase64Length(frame.image.byteLength)
    if (!this.canCarry(record, bytes)) {
      this.dropBinaryFrame(id, record, bytes)
      return
    }
    this.sendEvent(
      id,
      record,
      seq,
      this.binaryEventJson(id, seq, encodeBridgeScreencastFrame(frame)),
      true
    )
  }

  private binaryEventJson(id: string, seq: number, binary: BridgeBinaryEvent): string {
    return JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, binary })
  }

  /** One rule for what a stream can carry right now, read before a screencast frame is encoded and
   *  again on the frame that was. */
  private canCarry(record: OpenSubscription, bytes: number): boolean {
    return (
      bytes <= BRIDGE_MAX_MESSAGE_BYTES &&
      record.unacked.length < BRIDGE_MAX_UNACKED_FRAMES &&
      record.unackedBytes + bytes <= BRIDGE_MAX_UNACKED_BYTES
    )
  }

  private dropBinaryFrame(id: string, record: OpenSubscription, bytes: number): void {
    record.droppedFrames += 1
    this.droppedTotal += 1
    this.options.onBinaryFrameDropped({ id, bytes, droppedOnStream: record.droppedFrames })
  }

  /**
   * One frame out, or the stream's verdict on a frame that will not fit.
   *
   * The two kinds part here and nowhere else. A JSON event that cannot be carried ends the stream,
   * because its reader cannot see the hole it would leave and a transcript with a gap is worse than
   * one that stopped. A screencast frame is dropped and the stream lives: the next frame is one
   * throttle interval away, the pane is still showing the last one, and ending the stream would
   * black out a browser tab over a page that merely failed to compress.
   */
  private sendEvent(
    id: string,
    record: OpenSubscription,
    seq: number,
    json: string,
    binary: boolean
  ): void {
    const bytes = utf8ByteLength(json)
    // An event is never chunked, so one over the frame cap would be refused by the page's reader
    // and leave a hole nothing reports. Over the window, or too big to carry: same verdict, because
    // both mean this frame cannot be delivered whole.
    if (!this.canCarry(record, bytes)) {
      if (binary) {
        this.dropBinaryFrame(id, record, bytes)
        return
      }
      this.cancel(id, 'overflow')
      return
    }
    record.seq = seq
    record.unacked.push({ seq, bytes })
    record.unackedBytes += bytes
    this.options.post(json)
  }
}
