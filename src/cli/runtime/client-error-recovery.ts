import { RuntimeClientError, RuntimeRpcFailureError } from './types'

export function attachMutationRecovery(
  error: unknown,
  requestId: string | undefined,
  originalCommand?: string[],
  unsent = false
): unknown {
  if (!requestId || !(error instanceof RuntimeClientError)) {
    return error
  }
  const data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    orchestrationRequestId: requestId,
    ...(originalCommand ? { originalCommand } : {}),
    ...(unsent ? { requestSent: false } : {})
  }
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: {
        ...error.response.error,
        message: `${error.message} Orchestration mutation request ID: ${requestId}.`,
        data
      }
    })
  }
  return new RuntimeClientError(
    error.code,
    `${error.message} Orchestration mutation request ID: ${requestId}.`,
    data
  )
}

/** True when only the contract check ran, so this invocation never sent the request. */
export function isRequestUnsent(error: unknown): boolean {
  const data: unknown = error instanceof RuntimeClientError ? error.data : undefined
  return (
    typeof data === 'object' && data !== null && 'requestSent' in data && data.requestSent === false
  )
}
