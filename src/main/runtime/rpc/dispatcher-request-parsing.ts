import { compile, type ZodType } from 'zod'
import {
  formatZodError,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRequest,
  type RpcResponse
} from './core'
import { invalidArgumentResponse } from './dispatcher-error-response'

const compiledParams = new WeakMap<ZodType, ZodType>()

export function parseRpcRequestParams(
  request: RpcRequest,
  method: RpcAnyMethod,
  meta: RpcEnvelopeMeta
): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
  if (method.params === null) {
    return { value: undefined }
  }
  const result = getCompiledParams(method.params).safeParse(request.params ?? {})
  if (!result.success) {
    return {
      error: invalidArgumentResponse(request, meta, formatZodError(result.error))
    }
  }
  return { value: result.data }
}

function getCompiledParams(schema: ZodType): ZodType {
  const cached = compiledParams.get(schema)
  if (cached) {
    return cached
  }
  const compiled = compile(schema)
  compiledParams.set(schema, compiled)
  return compiled
}
