import { attachMutationRecovery } from './client-error-recovery'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'

const INSPECT_STEP = 'Inspect the terminal output and agent state without sending input.'

export function attachDurableMutationRecovery(
  error: unknown,
  requestId: string | undefined,
  originalCommand: string[] | undefined,
  method: string
): unknown {
  if (method !== 'terminal.send' || !requestId || !(error instanceof RuntimeClientError)) {
    return attachMutationRecovery(error, requestId, originalCommand)
  }
  const message = `${error.message} Terminal prompt request ID: ${requestId}. Re-issue the exact command with --retry-request ${requestId} --wait-submit <seconds>; do not retry it without that ID.`
  const data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    orchestrationRequestId: requestId,
    ...(originalCommand ? { originalCommand } : {})
  }
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, message, data }
    })
  }
  return new RuntimeClientError(error.code, message, data)
}

export function attachLegacyTerminalPromptRecovery(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  return attachUnknownTerminalPromptRecovery(
    error,
    'The legacy host cannot prove whether the prompt was delivered',
    [
      INSPECT_STEP,
      'Update Orca on the execution host before future prompt sends that need durable retry.'
    ]
  )
}

export function attachUnverifiedTerminalPromptRecovery(error: unknown): RuntimeClientError {
  const normalized =
    error instanceof RuntimeClientError
      ? error
      : new RuntimeClientError(
          'runtime_error',
          error instanceof Error ? error.message : String(error)
        )
  return attachUnknownTerminalPromptRecovery(
    normalized,
    'Orca cannot prove whether the prompt was delivered by the prompt-delivery-capable runtime from the preflight',
    [
      INSPECT_STEP,
      'A different Orca runtime answered than the one whose prompt-delivery support was verified; confirm which runtime serves this host before sending again.'
    ]
  )
}

/**
 * The prompt request ID survives a failed send unless a runtime other than the preflight's
 * prompt-delivery host handled it; a transport failure alone means nobody else answered, and the
 * attested host still holds the durable pending receipt that makes `--retry-request` idempotent.
 */
export function didAnotherRuntimeHandleTerminalPrompt(
  error: unknown,
  preflightRuntimeId: string | null,
  targetRuntimeId: string | null
): boolean {
  const handledBy =
    error instanceof RuntimeRpcFailureError
      ? (error.response._meta?.runtimeId ?? null)
      : targetRuntimeId
  if (handledBy === null) {
    return false
  }
  return (
    typeof preflightRuntimeId !== 'string' ||
    preflightRuntimeId.length === 0 ||
    handledBy !== preflightRuntimeId
  )
}

function attachUnknownTerminalPromptRecovery(
  error: RuntimeClientError,
  reason: string,
  nextSteps: string[]
): RuntimeClientError {
  const message = `${error.message} ${reason}; inspect the terminal before deciding what to do, and do not resend automatically.`
  const data: Record<string, unknown> = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    deliveryOutcome: 'unknown',
    retrySafe: false,
    nextSteps
  }
  delete data.orchestrationRequestId
  delete data.originalCommand
  delete data.recovery
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, message, data }
    })
  }
  return new RuntimeClientError(error.code, message, data)
}
