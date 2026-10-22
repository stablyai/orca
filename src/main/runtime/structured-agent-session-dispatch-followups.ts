// What the runtime does when a provider settles a dispatch after the fact. It runs off the request
// that caused it, so its failure has nobody to return to and is logged instead.

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
