import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import { BridgeClientClosedError, BridgeReplyRefusedError } from './bridge-client-errors'
import type { BridgeReplyMessage } from './bridge-envelope'
import { BridgeReplyAssembler } from './bridge-reply-chunking'
import { isBridgeNativeMethod } from './bridge-native-verbs'

export type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: unknown) => void
  timeout?: ReturnType<typeof setTimeout>
}

// Discard assembler state whenever a request settles or is abandoned; a missing final part otherwise holds one of the 64 slots until page close.
export class BridgeClientRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly assembler = new BridgeReplyAssembler()

  get size(): number {
    return this.pending.size
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  open(id: string, request: PendingRequest, timeoutMs: number, method: string): void {
    request.timeout = setTimeout(
      () =>
        this.fail(
          id,
          markRpcDeliveryUnknown(
            new Error(
              isBridgeNativeMethod(method) ? 'Request timed out' : `Request timed out: ${method}`
            )
          )
        ),
      timeoutMs
    )
    this.pending.set(id, request)
  }

  // A frame that never left has no assembler slot; settle it locally.
  abandon(id: string): void {
    clearTimeout(this.pending.get(id)?.timeout)
    this.pending.delete(id)
    this.assembler.discard(id)
  }

  acceptReply(message: BridgeReplyMessage): void {
    const assembly = this.assembler.accept(message)
    if (assembly.status === 'pending') {
      // Discard unsolicited reply parts too, or they consume an assembler slot.
      if (!this.pending.has(message.id)) {
        this.assembler.discard(message.id)
      }
      return
    }
    if (assembly.status === 'failed') {
      this.fail(message.id, new BridgeReplyRefusedError(assembly.refusal))
      return
    }
    this.settle(message.id, (request) => {
      request.resolve(assembly.payload)
    })
  }

  fail(id: string, error: unknown): void {
    this.settle(id, (request) => {
      clearTimeout(request.timeout)
      request.reject(error)
    })
  }

  // Reject all pending requests before returning, marked delivery-unknown because desktop execution may already have happened.
  closeAll(reason: Error = new BridgeClientClosedError()): void {
    const error = markRpcDeliveryUnknown(reason)
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
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
    clearTimeout(request.timeout)
    settleWith(request)
  }
}
