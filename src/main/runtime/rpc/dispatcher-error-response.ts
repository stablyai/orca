import { InvalidArgumentError, ZodError, formatZodError } from './core'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from './core'
import {
  computerErrorData,
  errorResponse,
  mapBrowserError,
  mapEmulatorError,
  mapRuntimeError
} from './errors'
import { ValidationLeaseFenced } from './validation-lease-fence'

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
  // Why before the per-namespace mappers: the fence applies to git/files/
  // terminal alike, and its typed code must survive whichever one would run.
  if (error instanceof ValidationLeaseFenced) {
    return errorResponse(request.id, meta, error.code, error.message, error.data)
  }
  if (request.method.startsWith('browser.')) {
    return mapBrowserError(request.id, meta, error)
  }
  if (request.method.startsWith('emulator.')) {
    return mapEmulatorError(request.id, meta, error)
  }
  return mapRuntimeError(request.id, meta, error)
}
