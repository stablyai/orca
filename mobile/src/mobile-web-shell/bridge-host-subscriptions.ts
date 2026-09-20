import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from './bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
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
}

/**
 * Every host subscription the page opened, and the backpressure window each one carries.
 *
 * Ending a stream is never silent. Dropping terminal bytes to keep a stream alive corrupts a
 * transcript, which the reader cannot see; a stream that ends says so, and the page can resubscribe.
 */
export class BridgeHostSubscriptions {
  private readonly open = new Map<string, OpenSubscription>()

  constructor(
    private readonly options: {
      client: RpcClient
      /** Fire and forget: the host owns rejection logging, and no post proves delivery. */
      post: (json: string) => void
    }
  ) {}

  get size(): number {
    return this.open.size
  }

  has(id: string): boolean {
    return this.open.has(id)
  }

  /** Throws whatever `client.subscribe` throws; the caller answers the page with `error`. */
  start(id: string, method: string, params: unknown): void {
    const record: OpenSubscription = {
      unsubscribe: () => undefined,
      seq: 0,
      unacked: [],
      unackedBytes: 0
    }
    this.open.set(id, record)
    let unsubscribe: () => void
    try {
      unsubscribe = this.options.client.subscribe(method, params, (payload) =>
        this.deliver(id, payload)
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
    const bytes = utf8ByteLength(json)
    // An event is never chunked, so one over the frame cap would be refused by the page's reader
    // and leave a hole nothing reports. Over the window, or too big to carry: same verdict, because
    // both mean this stream cannot be delivered whole.
    if (
      bytes > BRIDGE_MAX_MESSAGE_BYTES ||
      record.unacked.length >= BRIDGE_MAX_UNACKED_FRAMES ||
      record.unackedBytes + bytes > BRIDGE_MAX_UNACKED_BYTES
    ) {
      this.cancel(id, 'overflow')
      return
    }
    record.seq = seq
    record.unacked.push({ seq, bytes })
    record.unackedBytes += bytes
    this.options.post(json)
  }
}
