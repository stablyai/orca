const GENERIC_RETRY_ADVICE = [' Restart Orca and try again.', ' Retry the command.']

export function stripMutationResponseLossRetryAdvice(message: string): string {
  return GENERIC_RETRY_ADVICE.reduce((sanitized, advice) => sanitized.replace(advice, ''), message)
}
