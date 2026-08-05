import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

export type MobileRelayPendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export function rejectMobileRelayPendingRequests(
  pending: Map<string, MobileRelayPendingRequest>,
  error: Error
): void {
  if (pending.size === 0) {
    return
  }
  // Written frames may have executed before the Relay session failed.
  markRpcDeliveryUnknown(error)
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
}
