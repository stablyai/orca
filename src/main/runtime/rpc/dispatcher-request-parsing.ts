import {
  formatZodError,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRequest,
  type RpcResponse
} from './core'
import { invalidArgumentResponse } from './dispatcher-error-response'

export function parseRpcRequestParams(
  request: RpcRequest,
  method: RpcAnyMethod,
  meta: RpcEnvelopeMeta
): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
  if (method.params === null) {
    return { value: undefined }
  }
  const result = method.params.safeParse(request.params ?? {})
  if (!result.success) {
    return {
      error: invalidArgumentResponse(request, meta, formatZodError(result.error))
    }
  }
  return { value: result.data }
}
