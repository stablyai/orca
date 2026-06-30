import type {
  ScryerExecutorFailure,
  ScryerExecutorResult,
  ScryerOperationErrorCode,
  ScryerOperationOutcome
} from '../types'

export function success<TResult>(
  outcome: ScryerOperationOutcome<TResult>
): ScryerExecutorResult<TResult> {
  return { ok: true, outcome }
}

export function failure(
  code: ScryerOperationErrorCode,
  message: string,
  details?: Record<string, unknown>,
  extra: Omit<ScryerExecutorFailure, 'code' | 'message' | 'details'> = {}
): ScryerExecutorResult<never> {
  return {
    ok: false,
    failure: {
      code,
      message,
      ...(details ? { details } : {}),
      ...extra
    }
  }
}
