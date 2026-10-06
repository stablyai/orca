// What the runtime does when a provider settles a dispatch after the fact: a late answer to a send,
// or the provider going idle with sends it never answered. Both run off the request that caused
// them, so their failure has nobody to return to and is logged instead.

import { DISPATCH_DOUBT_PROVIDER_IDLE } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type DispatchFollowUpHost = Pick<
  StructuredAgentSessionHost,
  'settleLateDispatch' | 'releaseUnansweredDispatches'
>

export function createStructuredAgentSessionDispatchFollowUps(input: {
  /** Null until the host is built: the adapters that call these are built first. */
  host: () => DispatchFollowUpHost | null
  logger: StructuredAgentSessionLogger
}): {
  onDispatchSettledLate: (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ) => void
  releaseUnansweredDispatches: (input: { sessionId: string }) => void
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
    },
    // The provider going idle is what re-derives a doubted send; a late echo still accepts it.
    releaseUnansweredDispatches: ({ sessionId }) => {
      void input
        .host()
        ?.releaseUnansweredDispatches({ sessionId, reason: DISPATCH_DOUBT_PROVIDER_IDLE })
        .catch((error: unknown) =>
          logger.warn('releasing sends the idle provider never answered failed', {
            scope: 'unanswered-dispatch',
            sessionId,
            error
          })
        )
    }
  }
}
