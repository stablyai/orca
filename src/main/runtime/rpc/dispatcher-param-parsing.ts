import {
  formatZodError,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRequest,
  type RpcResponse
} from './core'
import { invalidArgumentResponse, validationErrorMessage } from './dispatcher-error-response'

export type ParsedRpcParams =
  | { value: unknown; error?: undefined }
  | { value?: undefined; error: RpcResponse }

// Why: STA-4818 — both dispatch entry points call this *outside* their own try, so a validator that
// throws instead of adding an issue used to escape as a rejected dispatch promise; the streaming
// transports then emitted zero reply frames and hung the caller. Every param schema funnels through
// here, so guarding the throw once answers the request on every transport. An unexpected throw is
// still logged, because a non-total validator is a programmer error, not an expected outcome.
export function parseRpcParams(
  request: RpcRequest,
  method: RpcAnyMethod,
  meta: RpcEnvelopeMeta
): ParsedRpcParams {
  if (method.params === null) {
    return { value: undefined }
  }
  const rawParams = request.params ?? {}
  let result: ReturnType<typeof method.params.safeParse>
  try {
    result = method.params.safeParse(rawParams)
  } catch (error) {
    // Why: a schema that throws a ZodError or InvalidArgumentError already said what is wrong —
    // report that verbatim, or the caller loses the diagnostic it would have had via safeParse.
    const validationMessage = validationErrorMessage(error)
    if (validationMessage !== null) {
      return { error: invalidArgumentResponse(request, meta, validationMessage) }
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[rpc] Param schema for ${request.method} threw during validation:`, error)
    return {
      error: invalidArgumentResponse(
        request,
        meta,
        `Invalid params for ${request.method}: ${detail}`
      )
    }
  }
  if (!result.success) {
    return { error: invalidArgumentResponse(request, meta, formatZodError(result.error)) }
  }
  return { value: result.data }
}
