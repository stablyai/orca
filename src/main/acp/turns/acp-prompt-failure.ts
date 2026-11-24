import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'

import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'

import {
  AcpAgentError,
  AcpAuthRequiredError,
  AcpSignInPromptError,
  acpErrorDataWords
} from '../transport/acp-errors'

/** Prefer provider error details over generic messages such as Internal error. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  // Orca's sign-in guidance already explains what to do.
  if (error instanceof AcpSignInPromptError) {
    return ''
  }
  return dialect.promptErrorDetail?.(error) ?? acpErrorDataWords(error.data) ?? error.message
}

export function acpAuthenticationRequired(dialect: AcpDialect, error: unknown): boolean {
  return (
    error instanceof AcpAuthRequiredError ||
    (error instanceof AcpAgentError && dialect.authenticationRequired?.(error) === true)
  )
}

/** What a failed prompt request says about its turn's ending. */
export function acpPromptFailureEnding(
  dialect: AcpDialect,
  error: Error,
  at: number
): AcpTurnEnding {
  const agentError = error instanceof AcpAgentError ? error : undefined
  const failure = agentError ? dialect.promptFailure?.(agentError, at) : undefined
  return {
    ...failure,
    stopReason: failure?.stopReason ?? 'error',
    at,
    failureDetail: agentError ? acpPromptErrorDetail(dialect, agentError) : undefined,
    notSignedIn: acpAuthenticationRequired(dialect, error),
    modelNotSelected: agentError ? dialect.modelCommand?.noModel(agentError) === true : false
  }
}

export function acpSignInRequiredFailure(
  dialect: AcpDialect,
  error: AcpAgentError
): SubmissionRejectionFact {
  const detail = providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  return agentSessionFailureFact('notSignedIn', {
    ...(detail ? { detail } : {}),
    ...(dialect.signInAccount ? { account: dialect.signInAccount } : {})
  })
}

/** Why the agent refused a prompt, as the person is told; a missing model outranks its sign-in wording. */
export function acpPromptRejection(
  refusal: string,
  signedOut: boolean,
  noModel: SubmissionRejectionFact | undefined
): SubmissionRejectionFact {
  if (noModel) {
    return noModel
  }
  const detail = providerDiagnostic(refusal, 'person')
  return agentSessionFailureFact(
    signedOut ? 'notSignedIn' : 'providerRejected',
    detail ? { detail } : {}
  )
}
