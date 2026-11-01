import type { RpcEnvelopeFields } from './rpc-envelope-fields'
import type { RpcResponse } from './types'

// Raw requests validate neither method, params nor result; use typed operations before treating replies as declared values.
// The request-port boundary inventory fences every remaining raw user and may only shrink.

export type SendRequestOptions = {
  timeoutMs?: number
  /** Include the connect wait in the caller's timeout budget. */
  budgetSpansConnect?: boolean
  /** Reject instead of replaying the request after reconnect. */
  failWhenDisconnected?: boolean
  /** Extra top-level wire fields; the transport's own always win. */
  envelope?: RpcEnvelopeFields
}

export type UnvalidatedRpcRequestPort = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
}
