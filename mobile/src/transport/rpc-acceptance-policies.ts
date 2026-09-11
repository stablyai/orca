import type { RpcResponse, RpcSuccess } from './types'

// Named acceptance policies for RPC replies. Call sites used to hand-roll these
// predicates and did not agree with each other; each policy here preserves one
// call site's existing acceptance exactly. Do not merge two policies without
// proving every caller of both tolerates the wider or narrower set.

/** Throws `code: message` on refusal. Diagnostic text; not user-facing. */
export function requireRpcResultOrThrowCodedError(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

/** Throws the host's message verbatim; the text reaches the user, so no code prefix. */
export function requireRpcResultOrThrowHostMessage(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

/** Accepts any successful reply, including a `null`, primitive or absent result. */
export function rpcResultOrNull(response: RpcResponse): unknown {
  return response.ok ? response.result : null
}

/**
 * Accepts only a success whose result is a non-null object. Arrays qualify.
 * Strictly narrower than `rpcResultOrNull`: a `null`, string or numeric result is refused.
 */
export function rpcObjectResultOrNull(response: RpcResponse): Record<string, unknown> | null {
  if (!response.ok || typeof response.result !== 'object' || response.result === null) {
    return null
  }
  return response.result as Record<string, unknown>
}

export function isMethodNotFoundRefusal(response: RpcResponse): boolean {
  return !response.ok && response.error.code === 'method_not_found'
}

/** A success that opened a stream rather than delivering a terminal result. */
export function isStreamingOpenerReply(
  response: RpcResponse
): response is RpcSuccess & { streaming: true } {
  return response.ok && response.streaming === true
}

/**
 * Well-formedness by the `ok` field alone. Deliberately weaker than `isRpcResponse`
 * in rpc-response-shape.ts, which also requires a string `id` and a validated error
 * shape — the one caller here accepts replies that carry no usable `id`.
 */
export function isRpcReplyWithBooleanOk(value: unknown): value is { ok: boolean } {
  return (
    Boolean(value) && typeof value === 'object' && typeof (value as RpcResponse).ok === 'boolean'
  )
}

/** A refusal whose error is structurally usable for classification. */
export function isCodedRpcRefusal(response: RpcResponse): boolean {
  if (response.ok) {
    return false
  }
  const error = response.error as { code?: unknown } | null | undefined
  return !!error && typeof error === 'object' && typeof error.code === 'string'
}
