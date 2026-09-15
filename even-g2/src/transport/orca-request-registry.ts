// Tracks in-flight sendRequest() calls by id, so a matching response (or a disconnect) can
// resolve/reject the right promise and clear its timeout.
import type { RpcResponse } from './orca-rpc-wire'

export type PendingRequest = {
  id: string
  method: string
  params: unknown
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PendingRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>()

  add(request: PendingRequest): void {
    this.pending.set(request.id, request)
  }

  delete(id: string): void {
    this.pending.delete(id)
  }

  // Removes and returns the entry so callers can't double-resolve it.
  take(id: string): PendingRequest | undefined {
    const request = this.pending.get(id)
    if (request) {
      this.pending.delete(id)
    }
    return request
  }

  values(): IterableIterator<PendingRequest> {
    return this.pending.values()
  }

  rejectAll(reason: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(reason))
    }
    this.pending.clear()
  }
}
