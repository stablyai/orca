import type { SubmissionRejectionFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { startSpan } from '../../../observability/tracer'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

/** One record per ended agent process naming who ended it, so a bare exit code is attributable. */
export function logProviderChildExit(
  logger: StructuredAgentSessionLogger,
  sessionId: string,
  child: Pick<StructuredAgentSessionProviderChild, 'generation' | 'close'>,
  end: {
    expected: boolean
    reason: string
    failure: SubmissionRejectionFact | undefined
    duringStartup: boolean
  }
): void {
  const { close } = child
  const fields = {
    scope: 'provider-exit',
    sessionId,
    generation: child.generation,
    endedBy: end.expected ? 'orca' : 'agent',
    reason: end.reason,
    duringStartup: end.duringStartup,
    ...(close ? { closeCause: close.cause, closeReason: close.reason } : {}),
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
