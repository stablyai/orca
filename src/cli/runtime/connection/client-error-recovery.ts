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
  // A refusal that applied nothing is final; a request id would read as an unknown outcome.
  if (!unsent && hasNoEffects(error.data)) {
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

/**
 * A request this invocation never wrote ran nothing now, but its key can still name an earlier
 * attempt that did, so it keeps the key and command with its no-write marker. A definitive
 * pre-send refusal stays bare: resending the same bytes would be refused the same way.
 */
export function attachUnsentMutationRecovery(
  error: unknown,
  requestId: string | undefined,
  originalCommand?: string[]
): unknown {
  return error instanceof RuntimeClientError && hasNoEffects(error.data)
    ? error
    : attachMutationRecovery(error, requestId, originalCommand, true)
}

/** True when this invocation never sent the request. */
export function isRequestUnsent(error: unknown): boolean {
  const data: unknown = error instanceof RuntimeClientError ? error.data : undefined
  return (
    typeof data === 'object' && data !== null && 'requestSent' in data && data.requestSent === false
  )
}

function hasNoEffects(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'effectsApplied' in data &&
    data.effectsApplied === false
  )
}
