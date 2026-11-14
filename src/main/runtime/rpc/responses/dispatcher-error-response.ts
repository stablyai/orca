import { BranchSwitchLandedWithWarningError } from '../../../git/worktrees/checkout/branch-switch'
import { mapBrowserError } from './browser-error-response'
import { ZodError } from 'zod'
import {
  InvalidArgumentError,
  formatZodError,
  type RpcEnvelopeMeta,
  type RpcRequest,
  type RpcResponse
} from '../core'

import { computerUseErrorRecoveryData } from '../../../../shared/computer-use-error-recovery'
import { errorResponse, mapEmulatorError, mapRuntimeError } from './rpc-response'
import { PluginHookDeniedError } from '../../../plugins/hooks/plugin-hook-dispatch'

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
    request.method.startsWith('computer.')
      ? computerUseErrorRecoveryData('invalid_argument')
      : undefined
  )
}

export function mapDispatcherError(
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  error: unknown
): RpcResponse {
  if (request.method === 'git.checkout' && error instanceof BranchSwitchLandedWithWarningError) {
    return errorResponse(request.id, meta, 'runtime_error', error.message, {
      outcome: 'landed-with-warning'
    })
  }
  if (error instanceof ZodError) {
    return invalidArgumentResponse(request, meta, formatZodError(error))
  }
  if (error instanceof InvalidArgumentError) {
    return invalidArgumentResponse(request, meta, error.message)
  }
  if (error instanceof PluginHookDeniedError) {
    // Final, not transient: a retry sends the same refused action.
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
