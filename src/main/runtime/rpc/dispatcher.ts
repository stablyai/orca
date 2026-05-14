// Why: the dispatcher is the one place that knows how to turn a validated
// RPC request into a response envelope. Splitting it from the transport
// makes it unit-testable without spinning up a socket, and keeps
// runtime-rpc.ts focused on framing/auth/connection bookkeeping.
import {
  ZodError,
  buildRegistry,
  formatZodError,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'
import { errorResponse, mapBrowserError, mapRuntimeError, successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import type { OrcaRuntimeService } from '../orca-runtime'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcAnyMethod[]
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    this.registry = buildRegistry(methods)
  }

  async dispatch(request: RpcRequest, options?: { signal?: AbortSignal }): Promise<RpcResponse> {
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

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      return parsedParams.error
    }

    // Why: streaming methods are not supported over one-shot transports like
    // Unix sockets. They require a reply function that can be called multiple
    // times, which is only available via dispatchStreaming.
    if (isStreamingMethod(method)) {
      return errorResponse(
        request.id,
        meta,
        'method_not_supported',
        `Method ${request.method} requires a streaming transport`
      )
    }

    try {
      const result = await method.handler(parsedParams.value, {
        runtime: this.runtime,
        signal: options?.signal
      })
      return successResponse(request.id, meta, result)
    } catch (error) {
      return this.mapError(request, meta, error)
    }
  }

  // Why: streaming dispatch sends multiple responses through the reply callback
  // instead of returning a single Promise. This enables terminal.subscribe and
  // other subscription-style methods that push data over time.
  async dispatchStreaming(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: {
      connectionId?: string
      clientId?: string
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    }
  ): Promise<void> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      reply(
        JSON.stringify(
          errorResponse(request.id, meta, 'method_not_found', `Unknown method: ${request.method}`)
        )
      )
      return
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      try {
        const result = await method.handler(parsedParams.value, {
          runtime: this.runtime,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          sendBinary: options?.sendBinary
        })
        reply(JSON.stringify(successResponse(request.id, meta, result)))
      } catch (error) {
        reply(JSON.stringify(this.mapError(request, meta, error)))
      }
      return
    }

    const emit = (result: unknown): void => {
      const response = successResponse(request.id, meta, result)
      response.streaming = true
      reply(JSON.stringify(response))
    }

    try {
      await method.handler(
        parsedParams.value,
        {
          runtime: this.runtime,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          sendBinary: options?.sendBinary
        },
        emit
      )
    } catch (error) {
      reply(JSON.stringify(this.mapError(request, meta, error)))
    }
  }

  private parseParams(
    request: RpcRequest,
    method: RpcAnyMethod,
    meta: RpcEnvelopeMeta
  ): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
    if (method.params === null) {
      return { value: undefined }
    }
    const rawParams = request.params ?? {}
    const result = method.params.safeParse(rawParams)
    if (!result.success) {
      return {
        error: errorResponse(request.id, meta, 'invalid_argument', formatZodError(result.error))
      }
    }
    return { value: result.data }
  }

  private mapError(request: RpcRequest, meta: RpcEnvelopeMeta, error: unknown): RpcResponse {
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

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
