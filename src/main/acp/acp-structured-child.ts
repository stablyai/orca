import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { AcpAgentError } from './acp-errors'
import { acpAuthenticationRequired, acpSignInRequiredFailure } from './acp-turn-failures'
import type { AcpStructuredSession } from './acp-structured-session'

export type AcpStructuredChild = Pick<
  AcpStructuredSession,
  | 'events'
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
  lane: AcpStructuredSession['lane'] | null
  turns: AcpStructuredSession['turns'] | null
  options: AcpStructuredSession['options']
  prompts: AcpStructuredSession['prompts']
  childStops?: AcpStructuredSession['childStops']
  unbindReadingControl?: () => void
  open: (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult>
  closing?: Promise<boolean>
  dispose: () => void
}

export function isAcpReadySession(
  session: AcpStructuredChild | null | undefined
): session is AcpStructuredSession & AcpStructuredChild {
  return session != null && session.lane !== null && session.turns !== null
}

export function acpStartupFailure(
  session: AcpStructuredChild,
  error: unknown
): SubmissionRejectionFact | undefined {
  if (error instanceof AcpAgentError && acpAuthenticationRequired(session.spec.dialect, error)) {
    // Use the agent's sign-in answer, excluding preceding diagnostic output.
    return acpSignInRequiredFailure(session.spec.dialect, error)
  }
  return undefined
}

export function assertAcpStartingSession(
  session: AcpStructuredChild,
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
