import { isSlowDispatchMutationMethod } from '../../shared/runtime-slow-dispatch'
import { RuntimeClientError } from './types'

export function attachMutationRecovery(error: unknown, requestId: string | undefined): unknown {
  if (!requestId || !(error instanceof RuntimeClientError)) {
    return error
  }
  return new RuntimeClientError(
    error.code,
    `${error.message} Orchestration mutation request ID: ${requestId}.`,
    {
      ...(error.data && typeof error.data === 'object' ? error.data : {}),
      orchestrationRequestId: requestId
    }
  )
}

export function attachSlowMutationCompletionWarning(error: unknown, method: string): unknown {
  if (!(error instanceof RuntimeClientError) || !isSlowDispatchMutationMethod(method)) {
    return error
  }
  const data =
    error.data && typeof error.data === 'object'
      ? (error.data as Record<string, unknown>)
      : undefined
  if (data?.requestPhase !== 'awaiting_response') {
    return error
  }
  return new RuntimeClientError(
    error.code,
    `The ${method} operation may have completed after the runtime connection closed before responding. Verify state before retrying.`,
    { ...data, mutationMayHaveCompleted: true }
  )
}
