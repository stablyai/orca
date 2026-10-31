import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import {
  bridgeScreencastBase64Length,
  bridgeScreencastFrameHeader,
  encodeBridgeScreencastFrame
} from './bridge/bridge-screencast-encoder'
import {
  BridgeTerminalOutputBacklog,
  drainTerminalBacklog,
  holdsTerminalOutput,
  terminalStreamMaxPayloadBytes,
  type TerminalBacklogEnd,
  type TerminalBacklogTimers
} from './bridge-terminal-output-backlog'
import type { BridgeBinaryEvent } from './bridge/bridge-screencast-binary'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcEnvelopeFields } from '../transport/rpc-envelope-fields'

export type BridgeEndReason = Extract<BridgeHostMessage, { type: 'end' }>['reason']

// Native enqueue proves no delivery; bound unacknowledged frames so a stalled reader cannot grow the native queue until process death.
export const BRIDGE_MAX_UNACKED_FRAMES = 256
export const BRIDGE_MAX_UNACKED_BYTES = 4 * 1024 * 1024

type UnackedFrame = { seq: number; bytes: number }

type OpenSubscription = {
  unsubscribe: () => void
  seq: number
  unacked: UnackedFrame[]
  unackedBytes: number
  droppedFrames: number
  backlog: BridgeTerminalOutputBacklog | null
}

export type BridgeTerminalBacklogReport = {
  id: string
  coalescedFrames: number
  deliveredFrames: number
  peakPendingBytes: number
  ended: TerminalBacklogEnd | null
}

export type BridgeDroppedBinaryFrame = {
  id: string
  bytes: number
  droppedOnStream: number
}

// Never silently drop terminal bytes to preserve a stream; report termination so the page can resubscribe rather than render a corrupt transcript.
export class BridgeHostSubscriptions {
  private readonly open = new Map<string, OpenSubscription>()
  private droppedTotal = 0

  constructor(
    private readonly options: {
      client: RpcClient
      post: (json: string) => void
      onBinaryFrameDropped: (dropped: BridgeDroppedBinaryFrame) => void
      onTerminalBacklog?: (report: BridgeTerminalBacklogReport) => void
      terminalTimers?: TerminalBacklogTimers
    }
  ) {}

  get size(): number {
    return this.open.size
  }

  // Keep dev-facts frame loss cumulative across every stream; resubscription must not reset it. Diagnostics retain per-stream counts.
  get droppedBinaryFrames(): number {
    return this.droppedTotal
  }

  has(id: string): boolean {
    return this.open.has(id)
  }

  // Request binary only when the page has its listener; otherwise encoding performs a full-image pass for frames it drops. Subscribe throws are returned as page errors.
  start(
    id: string,
    method: string,
    params: unknown,
    wantsBinary = false,
    envelope?: RpcEnvelopeFields
  ): void {
    const record: OpenSubscription = {
      unsubscribe: () => undefined,
      seq: 0,
      unacked: [],
      unackedBytes: 0,
      droppedFrames: 0,
      backlog: holdsTerminalOutput(method)
        ? new BridgeTerminalOutputBacklog({
            // No acknowledgement within the silence bound means the page stopped answering, rather than merely draining slowly.
            onAckSilence: () => this.endHeldStream(id, 'ack-silence'),
            timers: this.options.terminalTimers
          })
        : null
    }
    this.open.set(id, record)
    const onBinaryFrame = wantsBinary
      ? (frame: BrowserScreencastFrame) => this.deliverBinaryFrame(id, frame)
      : undefined
    let unsubscribe: () => void
    try {
      unsubscribe = this.options.client.subscribe(
        method,
        params,
        (payload) => this.deliver(id, payload),
        onBinaryFrame === undefined && envelope === undefined
          ? undefined
          : { onBinaryFrame, envelope }
      )
    } catch (error) {
      this.open.delete(id)
      record.backlog?.dispose()
      throw error
    }
    // A synchronous overflow retires the record before subscribe returns its cleanup; call the late unsubscribe now to avoid leaking it.
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
    record.backlog?.noteAck()
    this.drainBacklog(id, record)
  }

  // Null ends locally for a page that already said goodbye.
  cancel(id: string, reason: BridgeEndReason | null): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    this.open.delete(id)
    this.reportBacklog(id, record, null)
    try {
      record.unsubscribe()
    } catch {
      // A client whose unsubscribe throws must not keep the rest of the ledger open.
    }
    if (reason !== null) {
      this.options.post(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason }))
    }
  }

  // Map iteration tolerates deleting visited entries; avoid copying the ledger during teardown.
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
    const backlog = record.backlog
    // Hold terminal payloads before serialization when the window or existing backlog blocks delivery; the normal window path never sees them.
    if (backlog !== null && (backlog.held || !this.windowHasRoom(record))) {
      if (!backlog.hold(payload)) {
        this.endHeldStream(id, 'pending-ceiling')
      }
      return
    }
    const seq = record.seq + 1
    let json: string
    try {
      json = JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, payload })
    } catch {
      // End unserializable streams visibly; silently skipping their frame would corrupt the reader’s state.
      this.cancel(id, 'closed')
      return
    }
    this.sendEvent(id, record, seq, json, false)
  }

  // Use the same sequence ledger for binary and JSON; acknowledgements must not name frames never sent. Binary fields are all serializable.
  private deliverBinaryFrame(id: string, frame: BrowserScreencastFrame): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    const seq = record.seq + 1
    // Measure envelope plus exact ASCII base64 length before encoding; a closed window must not pay for full-image passes on discarded frames.
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

  private windowHasRoom(record: OpenSubscription): boolean {
    return (
      record.unacked.length < BRIDGE_MAX_UNACKED_FRAMES &&
      record.unackedBytes < BRIDGE_MAX_UNACKED_BYTES
    )
  }

  private drainBacklog(id: string, record: OpenSubscription): void {
    if (record.backlog === null) {
      return
    }
    drainTerminalBacklog({
      backlog: record.backlog,
      maxPayloadBytes: terminalStreamMaxPayloadBytes(id),
      windowHasRoom: () => this.windowHasRoom(record),
      availableWindowBytes: () => BRIDGE_MAX_UNACKED_BYTES - record.unackedBytes,
      windowEmpty: () => record.unacked.length === 0,
      send: (payload) => {
        const seq = record.seq + 1
        let json: string
        try {
          json = JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, payload })
        } catch {
          this.cancel(id, 'closed')
          return 'retired'
        }
        this.sendEvent(id, record, seq, json, false)
        // sendEvent may retire this stream; stop draining once the ledger no longer owns its record.
        return this.open.get(id) === record ? 'sent' : 'retired'
      }
    })
  }

  // Map both backlog endings to overflow for older page readers; an unknown reason would drop the end frame and strand the stream. Logs retain the precise cause.
  private endHeldStream(id: string, why: TerminalBacklogEnd): void {
    const record = this.open.get(id)
    if (record === undefined) {
      return
    }
    this.reportBacklog(id, record, why)
    this.cancel(id, 'overflow')
  }

  private reportBacklog(
    id: string,
    record: OpenSubscription,
    ended: TerminalBacklogEnd | null
  ): void {
    const backlog = record.backlog
    if (backlog === null) {
      return
    }
    record.backlog = null
    if (backlog.peakPendingBytes > 0) {
      this.options.onTerminalBacklog?.({
        id,
        coalescedFrames: backlog.coalescedFrames,
        deliveredFrames: backlog.deliveredFrames,
        peakPendingBytes: backlog.peakPendingBytes,
        ended
      })
    }
    backlog.dispose()
  }

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

  // End uncarryable JSON to avoid invisible state gaps; drop only screencast frames so the last image remains until the next one.
  private sendEvent(
    id: string,
    record: OpenSubscription,
    seq: number,
    json: string,
    binary: boolean
  ): void {
    const bytes = utf8ByteLength(json)
    // Every event must fit one frame. Held terminals bypass only the byte window for a single oversized chunk, never the frame cap (C0.3).
    const heldStream = record.backlog !== null
    if (heldStream ? bytes > BRIDGE_MAX_MESSAGE_BYTES : !this.canCarry(record, bytes)) {
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
