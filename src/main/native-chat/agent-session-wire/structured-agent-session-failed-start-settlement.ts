import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import { retryableStructuredAgentSessionStart } from './structured-agent-session-start-retry'

import type { StructuredAgentSessionStopEnding } from './structured-agent-session-host-lifetime'
import type * as hostTypes from './structured-agent-session-host-types'

import { sameProviderChild } from './structured-agent-session-provider-child'

import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

export function settleStructuredAgentSessionFailedStart(
  host: StructuredAgentSessionConversationLifetimeHost,
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>,
  sessionId: string,
  failed: hostTypes.StructuredAgentSessionProviderChildIdentity,
  error: unknown,
  openMs: number
): Promise<void> {
  const { serialize, sessions } = host
  const deps = () => host.context().deps
  return serialize(sessionId, async () => {
    const session = sessions.get(sessionId)
    const child = session?.child
    if (!session || !child || child.close || !sameProviderChild(child, failed)) {
      return
    }
    const failure = providerStartupFailureFact(error)
    // Persisted facts cannot retain the original error; log it here.
    deps().logger.warn('a provider could not finish starting', {
      scope: 'provider-open-failed',
      sessionId,
      failure: failure.kind,
      ...failure.requestTimeout,
      openMs,
      error
    })
    const { runtimeState: runtime } = host.context()
    const owned = runtime.startFlights.ownsChild(sessionId, child)
    if (owned) {
      const retry = retryableStructuredAgentSessionStart(error)
      runtime.startupAttempts.childFailed(sessionId, child, failure, retry)
    }
    try {
      if (!owned) {
        const record = deps().store.getRecord(sessionId)
        const wording = structuredAgentSessionFailureWordsContext(record)
        await recordStructuredAgentSessionStartFailure(
          { journal: session.journal, fence: child.fence },
          {
            startKey: child.generation,
            ...structuredAgentSessionStartFailure({ failure }, wording)
          },
          oldestQueuedSubmission(session)?.clientMessageId ?? null
        ).catch((writeError: unknown) =>
          deps().logger.warn('recording a failed provider open failed', {
            scope: 'provider-open-failure',
            sessionId,
            error: writeError
          })
        )
      }
      const reason = error instanceof Error ? error.message : String(error)
      await stopAgent(sessionId, { cause: 'host-stop', reason, failure })
    } finally {
      runtime.startupAttempts.childEnded(sessionId, child)
    }
  })
}
