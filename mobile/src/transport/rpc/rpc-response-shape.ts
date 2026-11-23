import type { RpcResponse } from './rpc-wire-types'

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  const response = value as {
    id?: unknown
    ok?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (typeof response.id !== 'string') {
    return false
  }
  if (response.ok === true) {
    // Not Object.hasOwn: the page's first scripts must run on iOS 15.1 to say it needs a newer iOS.
    // A parsed frame is a plain object, so nothing it inherits is named result.
    return 'result' in response
  }
  return (
    response.ok === false &&
    !!response.error &&
    typeof response.error.code === 'string' &&
    typeof response.error.message === 'string'
  )
}
