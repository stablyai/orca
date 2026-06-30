import type {
  ScryerErrorMapper,
  ScryerExecutorFailure,
  ScryerOperationContract,
  ScryerOperationError,
  ScryerOperationErrorCode,
  ScryerOperationResult
} from './types'

type ErrorArgs = {
  code: ScryerOperationErrorCode
  message: string
  details?: Record<string, unknown>
  fieldErrors?: ScryerOperationError['fieldErrors']
  path?: string
  jsonPointer?: string
  retryable?: boolean
}

function retryableByCode(code: ScryerOperationErrorCode): boolean {
  return code === 'lock_busy' || code === 'lease_required'
}

function operationError(args: ErrorArgs): ScryerOperationError {
  return {
    code: args.code,
    message: args.message,
    ...(args.details ? { details: args.details } : {}),
    ...(args.fieldErrors ? { fieldErrors: args.fieldErrors } : {}),
    ...(args.path ? { path: args.path } : {}),
    ...(args.jsonPointer ? { jsonPointer: args.jsonPointer } : {}),
    retryable: args.retryable ?? retryableByCode(args.code)
  }
}

function fromExecutorFailure(failure: ScryerExecutorFailure): ScryerOperationError {
  return operationError({
    code: failure.code,
    message: failure.message,
    details: failure.details,
    fieldErrors: failure.fieldErrors,
    path: failure.path,
    jsonPointer: failure.jsonPointer,
    retryable: failure.retryable
  })
}

export function createScryerErrorMapper(): ScryerErrorMapper {
  return {
    mapExecutorFailure(_args: {
      contract: ScryerOperationContract<unknown, unknown>
      failure: ScryerExecutorFailure
    }) {
      return fromExecutorFailure(_args.failure)
    },
    mapPipelineFailure(args) {
      return operationError(args)
    },
    mapStateStoreFailure(args) {
      return operationError(args)
    },
    mapUnexpectedException(args) {
      return operationError({
        code: 'internal_error',
        message:
          args.error instanceof Error
            ? args.error.message
            : `Unexpected Scryer engine error: ${String(args.error)}`,
        details: {
          reason: 'unexpected_exception',
          ...(args.contractOperationId ? { contractOperationId: args.contractOperationId } : {})
        }
      })
    },
    toOperationResult<TResult>(
      args:
        | {
            ok: true
            operationId: string
            requestId: string
            result: TResult
            meta?: ScryerOperationResult<TResult>['meta']
          }
        | {
            ok: false
            operationId: string
            requestId: string
            error: ScryerOperationError
            meta?: ScryerOperationResult<TResult>['meta']
          }
    ): ScryerOperationResult<TResult> {
      return args
    }
  }
}
