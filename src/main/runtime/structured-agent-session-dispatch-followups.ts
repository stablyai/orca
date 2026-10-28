// Late dispatch settlements run outside their request, so report failures through the logger.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type DispatchFollowUpHost = Pick<StructuredAgentSessionHost, 'settleLateDispatch'>

export function createStructuredAgentSessionDispatchFollowUps(input: {
  /** Null until the host is built: the adapters that call these are built first. */
  host: () => DispatchFollowUpHost | null
  logger: StructuredAgentSessionLogger
}): {
  onDispatchSettledLate: (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ) => void
} {
  const { logger } = input
  return {
    onDispatchSettledLate: (settlement) => {
      void input
        .host()
        ?.settleLateDispatch(settlement)
        .catch((error: unknown) =>
          logger.warn('settling a dispatch the provider answered late failed', {
            scope: 'late-settlement',
            sessionId: settlement.sessionId,
            error
          })
        )
    }
  }
}
