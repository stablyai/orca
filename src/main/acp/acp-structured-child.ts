import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AcpAgentError } from './acp-errors'
import { acpAuthenticationRequired, acpSignInRequiredFailure } from './acp-turn-failures'
import type { AcpStructuredSession } from './acp-structured-session'

export type AcpStartingSession = Pick<
  AcpStructuredSession,
  | 'sessionId'
  | 'fence'
  | 'acquisitionGeneration'
  | 'spec'
  | 'connection'
  | 'closeRequested'
  | 'journalClosed'
  | 'ended'
  | 'exitObservedAt'
> & {
  phase: 'starting'
  startupAnswered: boolean
  failure?: SubmissionRejectionFact
  closing?: Promise<boolean>
  dispose: () => void
}

export type AcpStructuredChild = AcpStartingSession | AcpStructuredSession

export function acpStartupFailure(
  session: AcpStartingSession,
  error: unknown
): SubmissionRejectionFact {
  if (error instanceof AcpAgentError && acpAuthenticationRequired(session.spec.dialect, error)) {
    // The agent's sign-in words, never log lines it wrote before refusing.
    return acpSignInRequiredFailure(session.spec.dialect, error)
  }
  const text =
    session.connection.stderrTail() || (error instanceof AcpAgentError ? error.message : '')
  const detail = providerDiagnostic(text, 'person')
  return agentSessionFailureFact('providerStartFailed', detail ? { detail } : {})
}

export function endAcpStartingSession(
  session: AcpStartingSession,
  observedAt: number,
  onEvent: ((event: StructuredAgentSessionLifecycleEvent) => void) | undefined
): void {
  if (session.ended) {
    return
  }
  session.ended = true
  session.exitObservedAt = observedAt
  session.dispose()
  const requested = session.closeRequested
  const failure = session.failure ?? acpStartupFailure(session, null)
  const detail = providerDiagnostic(session.connection.stderrTail(), 'person')
  onEvent?.({
    type: 'ended',
    sessionId: session.sessionId,
    reason:
      session.journalClosed ??
      (session.connection.stderrTail() || `${session.spec.agent} ACP agent ended while starting`),
    failure: requested
      ? agentSessionFailureFact('hostStopped')
      : detail && failure.kind !== 'notSignedIn'
        ? { ...failure, detail }
        : failure,
    cause: requested ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt,
    ...(!requested
      ? { startupUnproven: true, ...(!session.startupAnswered ? { startupUnanswered: true } : {}) }
      : {})
  })
}

export function assertAcpStartingSession(
  session: AcpStartingSession,
  abandoned: () => boolean
): void {
  if (
    session.ended ||
    session.closeRequested ||
    session.journalClosed !== null ||
    session.connection.exited ||
    session.connection.closed ||
    abandoned()
  ) {
    throw new Error(
      session.connection.stderrTail() || `${session.spec.command} closed while starting`
    )
  }
}
