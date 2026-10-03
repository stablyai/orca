import { startSpan } from '../../observability/tracer'
import { InvalidArgumentError, ZodError, formatZodError } from './core'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from './core'
import {
  computerErrorData,
  errorResponse,
  mapBrowserError,
  mapEmulatorError,
  mapRuntimeError
} from './errors'

export function invalidArgumentResponse(
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  message: string
): RpcResponse {
  return errorResponse(
    request.id,
    meta,
    'invalid_argument',
    message,
    request.method.startsWith('computer.') ? computerErrorData('invalid_argument') : undefined
  )
}

export function mapDispatcherError(
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  error: unknown
): RpcResponse {
  if (error instanceof ZodError) {
    return invalidArgumentResponse(request, meta, formatZodError(error))
  }
  if (error instanceof InvalidArgumentError) {
    return invalidArgumentResponse(request, meta, error.message)
  }
  if (request.method.startsWith('browser.')) {
    return mapBrowserError(request.id, meta, error)
  }
  if (request.method.startsWith('emulator.')) {
    return mapEmulatorError(request.id, meta, error)
  }
  const response = mapRuntimeError(request.id, meta, error)
  if (request.method.startsWith('runtimeAccess.') && response.error.code === 'runtime_error') {
    startSpan('rpc.runtime-access.unexpected-error').fail(
      error instanceof Error ? error : String(error)
    )
    return errorResponse(request.id, meta, 'runtime_error', 'Unexpected runtime error.')
  }
  return response
}
