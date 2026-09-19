import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge/bridge-caps'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { BridgeHostDisposedError } from './bridge-host-errors'

type RequestMessage = Extract<BridgeClientMessage, { type: 'request' }>

/** Live until something settles it; the flag is what keeps a cancelled request's late answer from
 *  being posted under an id the page has moved on from. */
type PendingRequest = { live: boolean }

export type BridgeHostRequestDeps = {
  client: RpcClient
  /** True when a subscription already holds this id; the two share one id space. */
  isIdTaken: (id: string) => boolean
  sendReply: (id: string, payload: RpcResponse) => void
  sendError: (id: string, error: unknown) => void
  capExceeded: (message: string) => Error
}

/**
 * The requests one page document has in flight, forwarded to the shell's client and settled back.
 *
 * `pending` is the page's view and empties on a cancel or a `close`; `inFlight` is the client's and
 * does not, because `sendRequest` has no cancel. The call keeps its slot on the wire until it
 * settles, and a page that closed between batches would otherwise be handed the cap over again.
 */
export class BridgeHostRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private inFlight = 0

  constructor(private readonly deps: BridgeHostRequestDeps) {}

  has(id: string): boolean {
    return this.pending.has(id)
  }

  /** `sendRequest` has no cancel: the desktop still runs it, and this only stops the host from
   *  posting an answer under an id the page has stopped waiting on. */
  cancel(id: string): void {
    const record = this.pending.get(id)
    if (record !== undefined) {
      this.settle(id, record)
    }
  }

  private settle(id: string, record: PendingRequest): boolean {
    if (!record.live) {
      return false
    }
    record.live = false
    this.pending.delete(id)
    return true
  }

  /** The arity the page used, replayed exactly: `sendRequest(m)` and `sendRequest(m, undefined)`
   *  are different calls to the golden recorder. */
  private forward(message: RequestMessage): Promise<RpcResponse> {
    const { client } = this.deps
    if (message.options !== undefined) {
      return client.sendRequest(message.method, message.params, message.options)
    }
    return 'params' in message
      ? client.sendRequest(message.method, message.params)
      : client.sendRequest(message.method)
  }

  open(message: RequestMessage): void {
    const { id } = message
    // An id already in flight is a page bug; refusing the newcomer leaves the exchange it collided
    // with intact, which settling it would not.
    if (this.pending.has(id) || this.deps.isIdTaken(id)) {
      this.deps.sendError(id, this.deps.capExceeded('that id is already in flight'))
      return
    }
    if (this.inFlight >= BRIDGE_MAX_PENDING_REQUESTS) {
      this.deps.sendError(id, this.deps.capExceeded(`over ${BRIDGE_MAX_PENDING_REQUESTS} requests`))
      return
    }
    const record: PendingRequest = { live: true }
    this.pending.set(id, record)
    let answer: Promise<RpcResponse>
    try {
      answer = this.forward(message)
    } catch (error) {
      this.settle(id, record)
      this.deps.sendError(id, error)
      return
    }
    this.inFlight += 1
    void answer.then(
      (payload) => {
        this.inFlight -= 1
        if (this.settle(id, record)) {
          this.deps.sendReply(id, payload)
        }
      },
      (error: unknown) => {
        this.inFlight -= 1
        if (this.settle(id, record)) {
          this.deps.sendError(id, error)
        }
      }
    )
  }

  /** `notify` is false for the page's own `close`, which has already settled what it owned. */
  closeAll(notify: boolean): void {
    for (const [id, record] of this.pending) {
      record.live = false
      // In flight when the door shut: the desktop may already have run it, and a page told this was
      // a definite send failure would offer to retry something that already happened.
      if (notify) {
        this.deps.sendError(id, markRpcDeliveryUnknown(new BridgeHostDisposedError()))
      }
    }
    this.pending.clear()
  }
}
