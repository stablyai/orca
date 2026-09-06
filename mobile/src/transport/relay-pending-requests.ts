import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** In-flight relay RPC requests awaiting their response frame, keyed by request id. */
export class RelayPendingRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0

  nextId(): string {
    return `relay-rpc-${++this.requestCounter}-${Date.now()}`
  }

  track(id: string, request: PendingRequest): void {
    this.pending.set(id, request)
  }

  drop(id: string): void {
    this.pending.delete(id)
  }

  /** Settle the waiter for this response; false when no request owns it. */
  settle(response: RpcResponse): boolean {
    const request = this.pending.get(response.id)
    if (!request) {
      return false
    }
    clearTimeout(request.timer)
    this.pending.delete(response.id)
    request.resolve(response)
    return true
  }

  rejectAll(error: Error): void {
    if (this.pending.size === 0) {
      return
    }
    // Why: pending entries only exist after their frame reached the authenticated
    // link (sendFrame failures delete them synchronously), so the desktop may
    // have processed them — mark the ambiguity for callers.
    markRpcDeliveryUnknown(error)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
