import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import {
  readCodexErrorAdditionalDetails,
  readCodexErrorInfo,
  readCodexErrorMessage
} from './codex-structured-thread-facts'

const HTTP_ERROR_KINDS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts'
]

/** Only the protocol's unauthorized variant or an HTTP error carrying 401 proves sign-out. */
export function codexAuthenticationFailure(payload: unknown, account?: AgentSessionAccountKind) {
  const info = readCodexErrorInfo(payload)
  if (
    info?.error !== 'unauthorized' &&
    !(info?.status === 401 && HTTP_ERROR_KINDS.includes(info.error))
  ) {
    return null
  }
  const message = readCodexErrorMessage(payload)
  const additional = readCodexErrorAdditionalDetails(payload)
  const text = [message, additional && additional !== message ? additional : null]
    .filter((part): part is string => part !== null)
    .join('\n')
  return agentSessionFailureFact('notSignedIn', {
    account,
    detail: providerDiagnostic(text, 'person')
  })
}
