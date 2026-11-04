import type { SendRequestOptions } from '../../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import { BridgeClientClosedError, BridgeReplyRefusedError } from './bridge-client-errors'
import type { BridgeReplyMessage } from './bridge-envelope'
import { BridgeReplyAssembler } from './bridge-reply-chunking'

export type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: unknown) => void
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

  open(id: string, request: PendingRequest): void {
    this.pending.set(id, request)
  }

  // A frame that never left has no assembler slot; settle it locally.
  abandon(id: string): void {
    this.pending.delete(id)
  }

  wait(
    id: string,
    response: Promise<RpcResponse>,
    options: SendRequestOptions | undefined,
    cancel: () => void
  ): Promise<RpcResponse> {
    const signal = options?.signal
    if (!signal) {
      return response
    }
    return new Promise((resolve, reject) => {
      // Pending-map removal precedes raw reaction delivery; an abort in between must still win.
      let terminal = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        signal.removeEventListener('abort', onAbort)
      }
      const abandon = (error: Error) => {
        if (terminal) {
          return
        }
        terminal = true
        cleanup()
        this.fail(id, new Error('Request abandoned'))
        cancel()
        reject(error)
      }
      const onAbort = () =>
        abandon(Object.assign(new Error('Promise settlement wait aborted'), { name: 'AbortError' }))
      void response.then(
        (value) => {
          if (!terminal) {
            terminal = true
            cleanup()
            resolve(value)
          }
        },
        (error: unknown) => {
          if (!terminal) {
            terminal = true
            cleanup()
            reject(error)
          }
        }
      )
      if (signal.aborted) {
        onAbort()
        return
      }
      timer = setTimeout(
        () => abandon(new Error('Promise settlement wait timed out')),
        Math.max(1, options?.timeoutMs ?? 30_000)
      )
      const handle: unknown = timer
      if (
        typeof handle === 'object' &&
        handle !== null &&
        'unref' in handle &&
        typeof handle.unref === 'function'
      ) {
        handle.unref()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
      }
    })
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
      request.reject(error)
    })
  }

  // Reject all pending requests before returning, marked delivery-unknown because desktop execution may already have happened.
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
