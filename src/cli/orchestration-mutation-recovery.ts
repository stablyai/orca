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
      : undefined,
    // Why: the mutation may have landed, so a residual handle here can be a live worker.
    Array.isArray(data?.residualResources) && data.residualResources.length > 0
      ? 'Do not close a residual resource on this path; retry first and act on the receipt the retry returns.'
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
