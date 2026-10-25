import type { RpcResponse, RpcSuccess } from './types'

// Keep acceptance policies distinct until every caller is proven compatible with any widened/narrowed reply set.

/** Throws `code: message` on refusal. Diagnostic text; not user-facing. */
export function requireRpcResultOrThrowCodedError(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

/** Accepts only a success whose result is a non-null object. Arrays qualify. */
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

/** New-tab errors historically show the host message without its diagnostic code. */
export function requireRpcResultOrThrowMessage(response: RpcResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

/** An accepted null result still commits; a refused reply leaves existing state alone. */
export function rpcSuccessResultOrSkip(
  response: RpcResponse
): { accepted: false } | { accepted: true; value: unknown } {
  return response.ok ? { accepted: true, value: response.result } : { accepted: false }
}
