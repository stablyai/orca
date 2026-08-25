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

// Why: one definition of "this error already carries a caller-facing validation message", shared
// with the param-parsing guard so a thrown ZodError reads the same wherever it surfaced.
export function validationErrorMessage(error: unknown): string | null {
  if (error instanceof ZodError) {
    return formatZodError(error)
  }
  if (error instanceof InvalidArgumentError) {
    return error.message
  }
  return null
}

export function mapDispatcherError(
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  error: unknown
): RpcResponse {
  const validationMessage = validationErrorMessage(error)
  if (validationMessage !== null) {
    return invalidArgumentResponse(request, meta, validationMessage)
  }
  if (request.method.startsWith('browser.')) {
    return mapBrowserError(request.id, meta, error)
  }
  if (request.method.startsWith('emulator.')) {
    return mapEmulatorError(request.id, meta, error)
  }
  return mapRuntimeError(request.id, meta, error)
}
