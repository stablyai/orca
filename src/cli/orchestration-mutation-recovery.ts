import { RuntimeClientError } from './runtime-client'

export function orchestrationMutationRecoveryError(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || !isUnknownMutationOutcomeCode(error.code)) {
    return error
  }
  const data = objectRecord(error.data)
  const requestId = data?.orchestrationRequestId
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return error
  }
  const message = [
    stripUnsafeRetryAdvice(error.message, requestId),
    'The orchestration mutation may already have taken effect; do not assume it failed.',
    `Re-issue the same command with --retry-request ${requestId} to recover idempotently. Do not retry this mutation without --retry-request.`,
    typeof data?.failedStage === 'string' ? `Failed stage: ${data.failedStage}.` : undefined,
    Array.isArray(data?.residualResources)
      ? `Residual resources: ${JSON.stringify(data.residualResources)}.`
      : undefined
  ].filter((line): line is string => line !== undefined)
  return new RuntimeClientError(error.code, message.join('\n'), error.data)
}

function isUnknownMutationOutcomeCode(code: string): boolean {
  return [
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'invalid_runtime_response'
  ].includes(code)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function stripUnsafeRetryAdvice(message: string, requestId: string): string {
  return message
    .replace(' Restart Orca and try again.', '')
    .replace(' Retry the command.', '')
    .replace(` Orchestration mutation request ID: ${requestId}.`, '')
}
