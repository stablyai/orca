import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import { BridgeClientClosedError, BridgeReplyRefusedError } from './bridge-client-errors'
import type { BridgeReplyMessage } from './bridge-envelope'
import { BridgeReplyAssembler } from './bridge-reply-chunking'

export type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: unknown) => void
}

/**
 * The page's in-flight requests, and the replies that settle them.
 *
 * Nothing here expires an id on its own, so every id this opens is discarded from the assembler the
 * moment it settles or is abandoned: a reply whose last part never arrives would otherwise hold a
 * slot until the page closes, and 64 of those are the whole in-flight budget.
 */
export class BridgeClientRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly assembler = new BridgeReplyAssembler()

  get size(): number {
    return this.pending.size
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  open(id: string, request: PendingRequest): void {
    this.pending.set(id, request)
  }

  /** For a frame that never left the page: the caller settles it, and no part can have arrived for
   *  an id the shell was never told about, so there is no assembler slot to give back. */
  abandon(id: string): void {
    this.pending.delete(id)
  }

  acceptReply(message: BridgeReplyMessage): void {
    const assembly = this.assembler.accept(message)
    if (assembly.status === 'pending') {
      // A part for an id nobody is waiting on still costs a slot until it is discarded.
      if (!this.pending.has(message.id)) {
        this.assembler.discard(message.id)
      }
      return
    }
    if (assembly.status === 'failed') {
      this.fail(message.id, new BridgeReplyRefusedError(assembly.refusal))
      return
    }
    // A host `RpcFailure` resolves: it is data the caller reads, and the goldens record it.
    this.settle(message.id, (request) => {
      request.resolve(assembly.payload)
    })
  }

  fail(id: string, error: unknown): void {
    this.settle(id, (request) => {
      request.reject(error)
    })
  }

  /**
   * Every pending request reaches its caller before this returns, and each one rejects
   * delivery-unknown: the desktop may already have run it, and a caller told this was a definite
   * send failure would offer to retry something that already happened.
   */
  closeAll(reason: Error = new BridgeClientClosedError()): void {
    const error = markRpcDeliveryUnknown(reason)
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
    this.assembler.clear()
  }

  private settle(id: string, settleWith: (request: PendingRequest) => void): void {
    this.assembler.discard(id)
    const request = this.pending.get(id)
    if (request === undefined) {
      return
    }
    this.pending.delete(id)
    settleWith(request)
  }
}
