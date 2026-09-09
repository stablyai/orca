import { RuntimeClientError, RuntimeRpcFailureError } from './types'

export function attachMutationRecovery(
  error: unknown,
  requestId: string | undefined,
  originalCommand?: string[]
): unknown {
  if (!requestId || !(error instanceof RuntimeClientError)) {
    return error
  }
  const data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    orchestrationRequestId: requestId,
    ...(originalCommand ? { originalCommand } : {})
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
