import type { StructuredAgentStartupFailure } from './structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { providerStartupFailureFact } from './structured-agent-session-failure-text'
import { retryableStructuredAgentSessionStart } from './structured-agent-session-start-retry'

export function personallyClosingStartup(child: StructuredAgentSessionProviderChild): boolean {
  const close = child.close
  return Boolean(
    close?.quit ||
    close?.cause === 'user-stop' ||
    close?.cause === 'user-close' ||
    close?.cause === 'context-clear'
  )
}

/** Called under the session lane; neither open nor an independent end owns the other's delivery. */
export function reportStructuredAgentStartupFailure(input: {
  child: StructuredAgentSessionProviderChild
  sessionId: string
  error: unknown
  projection?: StructuredAgentStartupFailure
  openMs?: number
  logger: StructuredAgentSessionLogger
  startupAttempts?: Pick<StructuredAgentSessionStartupAttempts, 'childFailed'>
  startFlights?: Pick<StructuredAgentSessionStartFlights, 'ownsChild'>
}): StructuredAgentStartupFailure {
  const { child, sessionId } = input
  if (child.reportedStartupFailure) {
    return child.reportedStartupFailure
  }
  const projection = input.projection ?? {
    error: input.error instanceof Error ? input.error : new Error(String(input.error)),
    failure: providerStartupFailureFact(input.error),
    initiator: 'startup-failure' as const
  }
  child.reportedStartupFailure = projection
  try {
    input.logger.warn('a provider could not finish starting', {
      scope: 'provider-open-failed',
      sessionId,
      failure: projection.failure.kind,
      ...projection.failure.requestTimeout,
      ...(input.openMs === undefined ? {} : { openMs: input.openMs }),
      error: input.error
    })
  } catch {
    /* Reporting must not suppress the original submission settlement. */
  }
  if (!personallyClosingStartup(child) && input.startFlights?.ownsChild(sessionId, child)) {
    input.startupAttempts?.childFailed(
      sessionId,
      child,
      projection.failure,
      retryableStructuredAgentSessionStart(projection.error)
    )
  }
  return projection
}
