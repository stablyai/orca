import { DaemonProtocolError } from './types'
import type { RpcResponse } from './types'
import { addNodePtyRecoveryHint } from './node-pty-error-hints'
import { decodeDaemonResponseError } from './daemon-errors'

export type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DaemonPendingRequests {
  private requests = new Map<string, PendingRequest>()

  get size(): number {
    return this.requests.size
  }

  add(id: string, pending: PendingRequest): void {
    this.requests.set(id, pending)
  }

  drop(id: string): void {
    this.requests.delete(id)
  }

  settle(response: RpcResponse): void {
    if (response.id) {
      const pending = this.requests.get(response.id)
      if (pending) {
        this.requests.delete(response.id)
        clearTimeout(pending.timer)
        if (response.ok) {
          pending.resolve(response.payload)
        } else {
          const decoded = decodeDaemonResponseError(response.error)
          pending.reject(
            decoded instanceof DaemonProtocolError
              ? new DaemonProtocolError(addNodePtyRecoveryHint(response.error))
              : decoded
          )
        }
      }
    }
  }

  rejectAll(reason: string): void {
    for (const [id, pending] of this.requests) {
      clearTimeout(pending.timer)
      pending.reject(new DaemonProtocolError(reason))
      this.requests.delete(id)
    }
  }
}
