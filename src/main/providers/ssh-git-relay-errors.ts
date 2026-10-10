import { JsonRpcErrorCode } from '../ssh/relay-protocol'

export function isJsonRpcMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
}
