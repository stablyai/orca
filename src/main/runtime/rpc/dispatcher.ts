// Why: the dispatcher is the one place that knows how to turn a validated
// RPC request into a response envelope. Splitting it from the transport
// makes it unit-testable without spinning up a socket, and keeps
// runtime-rpc.ts focused on framing/auth/connection bookkeeping.
import {
  ZodError,
  buildRegistry,
  formatZodError,
  type RpcEnvelopeMeta,
  type RpcMethod,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'
import { errorResponse, mapBrowserError, mapRuntimeError, successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import type { OrcaRuntimeService } from '../orca-runtime'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcMethod[]
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    this.registry = buildRegistry(methods)
  }

  async dispatch(request: RpcRequest): Promise<RpcResponse> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      return errorResponse(
        request.id,
        meta,
        'method_not_found',
        `Unknown method: ${request.method}`
      )
    }

    let parsedParams: unknown
    if (method.params === null) {
      parsedParams = undefined
    } else {
      const rawParams = request.params ?? {}
      const result = method.params.safeParse(rawParams)
      if (!result.success) {
        return errorResponse(request.id, meta, 'invalid_argument', formatZodError(result.error))
      }
      parsedParams = result.data
    }

    try {
      const result = await method.handler(parsedParams, { runtime: this.runtime })
      return successResponse(request.id, meta, result)
    } catch (error) {
      // Why: browser methods throw BrowserError with a structured `code`;
      // every other runtime error has a plain-message code. Routing by method
      // prefix keeps the mapping a single decision rather than a per-method
      // flag callers must remember to set.
      if (request.method.startsWith('browser.')) {
        return mapBrowserError(request.id, meta, error)
      }
      if (error instanceof ZodError) {
        return errorResponse(request.id, meta, 'invalid_argument', formatZodError(error))
      }
      return mapRuntimeError(request.id, meta, error)
    }
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
