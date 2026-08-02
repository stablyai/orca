import type { RpcResponse } from './types'

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
    return Object.prototype.hasOwnProperty.call(response, 'result')
  }
  return (
    response.ok === false &&
    !!response.error &&
    typeof response.error.code === 'string' &&
    typeof response.error.message === 'string'
  )
}
