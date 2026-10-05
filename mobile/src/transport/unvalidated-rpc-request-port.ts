import type { RpcResponse } from './types'

// The raw request port, kept in its own module so that reaching it is a visible act.
//
// Nothing on this path is checked against the host contract: `method` is an unconstrained
// string, `params` is `unknown`, and the reply's `result` stays `unknown`. A value that came
// back through here has been parsed as JSON and nothing more, so it is NOT validated and must
// not be annotated as though it were. The typed boundary — defineRpcOperation and the send
// helpers in rpc-operation.ts — is the only path that turns a reply into a declared type, and
// rpc-operation.ts is the only module here that should be importing this one for that purpose.
//
// Every other file that still reaches this port is inventoried in
// unvalidated-rpc-request-port-inventory.ts and fenced by
// unvalidated-rpc-request-port-boundary.test.ts. That list only shrinks.

export type SendRequestOptions = {
  timeoutMs?: number
  /** Include the connect wait in the caller's timeout budget. */
  budgetSpansConnect?: boolean
  /** Reject instead of replaying the request after reconnect. */
  failWhenDisconnected?: boolean
}

/** Unvalidated: an arbitrary method name in, an unread envelope out. */
export type UnvalidatedRpcRequestPort = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
}
