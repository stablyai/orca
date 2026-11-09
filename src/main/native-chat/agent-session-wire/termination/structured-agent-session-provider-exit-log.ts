import type { SubmissionRejectionFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { redactString } from '../../../observability/redactor'
import { startSpan } from '../../../observability/tracer'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionChildExit } from './structured-agent-session-child-exit-record'

/** One record per ended agent process naming who ended it, so a bare exit code is attributable. */
export function logProviderChildExit(
  logger: StructuredAgentSessionLogger,
  sessionId: string,
  child: Pick<StructuredAgentSessionProviderChild, 'generation' | 'close'>,
  end: {
    expected: boolean
    exit: Pick<StructuredAgentSessionChildExit, 'reason' | 'closedByOrca'>
    failure: SubmissionRejectionFact | undefined
    duringStartup: boolean
  }
): void {
  const { close } = child
  const fields = {
    scope: 'provider-exit',
    sessionId,
    generation: child.generation,
    // A close Orca made after its own failure still reads as unexpected to the turn.
    endedBy: end.expected || close || end.exit.closedByOrca ? 'orca' : 'agent',
    // The reason can carry the agent's stderr tail; the console line is not redacted downstream.
    reason: redactString(end.exit.reason),
    duringStartup: end.duringStartup,
    ...(close
      ? { closeCause: close.cause, closeReason: close.reason && redactString(close.reason) }
      : {}),
    ...(close?.quit ? { quit: true } : {}),
    ...(end.failure ? { failure: end.failure.kind } : {})
  }
  // A host-fault close counts as unexpected upstream, so it warns too.
  if (!end.expected) {
    logger.warn('agent process ended', fields)
    return
  }
  // A requested end is normal; record it without a failed span.
  try {
    startSpan('agentSession.provider-exit', { attributes: fields }).end()
    console.info('[agent-session] provider-exit: agent process ended by Orca', fields)
  } catch {
    // Diagnostics never fail the exit they describe.
  }
}

export function logExitFailure(
  context: { logger: StructuredAgentSessionLogger },
  sessionId: string,
  scope: string,
  error: unknown
): void {
  context.logger.warn('settling a provider exit did not finish', { scope, sessionId, error })
}
