// src/renderer/src/runtime/runtime-rpc-result.ts
// RuntimeRpcCallError / unwrapRuntimeRpcResult / isRuntimeScopeForbiddenError —
// split out of runtime-rpc-client.ts (max-lines budget) into their own file
// with no dependency on the rest of that module, so runtime-compatibility-
// cache.ts can depend on this without creating a cycle back to
// runtime-rpc-client.ts. Re-exported from runtime-rpc-client.ts unchanged.
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export class RuntimeRpcCallError extends Error {
  readonly code: string
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.message)
    this.name = 'RuntimeRpcCallError'
    this.code = response.error.code
    this.response = response
  }
}

// Why: mobile-scope device tokens are denied non-allowlisted runtime methods
// with code 'forbidden'. Callers use this to surface one scope-mismatch banner
// instead of silently swallowing the failure into empty/retry-looping UI.
export function isRuntimeScopeForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'forbidden'
}

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
