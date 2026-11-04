import type { SendRequestOptions } from '../../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import { RPC_REQUEST_MIN_ACK_MS } from '../../transport/rpc-request-budget'
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

// Time for the shell's final reply to cross the bridge after its own deadline answer.
export const BRIDGE_REPLY_HANDOFF_ALLOWANCE_MS = 2_000
const MAX_TIMER_MS = 2 ** 31 - 1

// The shell owns an ordinary request's deadline: its connect wait and response budget may each take
// the timeout. The page only backstops a silent bridge, after both legs, the ack floor and a handoff.
export function bridgeOrdinaryBackstopMs(timeoutMs: number): number {
  const backstop = 2 * timeoutMs + RPC_REQUEST_MIN_ACK_MS + BRIDGE_REPLY_HANDOFF_ALLOWANCE_MS
  return Math.min(MAX_TIMER_MS, Math.max(1, backstop))
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

  // Native verbs run on the shell itself and keep their own deadline. An ordinary request's backstop
  // settles it unknown once and tells the shell to drop it, so a still-queued send never leaves.
  open(
    id: string,
    request: PendingRequest,
    timeoutMs: number,
    method: string,
    cancel: () => void
  ): void {
    const native = isBridgeNativeMethod(method)
    request.timeout = setTimeout(
      () => {
        if (!this.pending.has(id)) {
          return
        }
        this.fail(
          id,
          markRpcDeliveryUnknown(
            new Error(native ? 'Request timed out' : `Request timed out: ${method}`)
          )
        )
        if (!native) {
          cancel()
        }
      },
      native ? timeoutMs : bridgeOrdinaryBackstopMs(timeoutMs)
    )
    this.pending.set(id, request)
  }

  // A frame that never left has no assembler slot; settle it locally.
  abandon(id: string): void {
    clearTimeout(this.pending.get(id)?.timeout)
    this.pending.delete(id)
    this.assembler.discard(id)
  }

  // Only the caller's abort ends the wait early; automatic expiry is the pending request's backstop.
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
      const onAbort = () => {
        if (terminal) {
          return
        }
        terminal = true
        this.fail(id, new Error('Request abandoned'))
        cancel()
        reject(Object.assign(new Error('Promise settlement wait aborted'), { name: 'AbortError' }))
      }
      void response.then(
        (value) => {
          if (!terminal) {
            terminal = true
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          }
        },
        (error: unknown) => {
          if (!terminal) {
            terminal = true
            signal.removeEventListener('abort', onAbort)
            reject(error)
          }
        }
      )
      if (signal.aborted) {
        onAbort()
        return
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
