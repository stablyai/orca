import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'
import type { RpcRequestDeadline } from './rpc-request-keepalive'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  deadline: RpcRequestDeadline
  written: boolean
}

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

  /** A retired or unknown request's keepalive renews nothing. */
  keepalive(id: string): void {
    this.pending.get(id)?.deadline.renew()
  }

  markWritten(id: string): void {
    const request = this.pending.get(id)
    if (request) {
      request.written = true
    }
  }

  settle(response: RpcResponse): boolean {
    const request = this.pending.get(response.id)
    if (!request) {
      return false
    }
    request.deadline.clear()
    this.pending.delete(response.id)
    request.resolve(response)
    return true
  }

  rejectAll(error: Error): void {
    if (this.pending.size === 0) {
      return
    }
    for (const request of this.pending.values()) {
      request.deadline.clear()
      request.reject(request.written ? markRpcDeliveryUnknown(new Error(error.message)) : error)
    }
    this.pending.clear()
  }
}
