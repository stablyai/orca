import { StructuredAgentSessionRequestFailures } from './structured-agent-session-request-failures'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export function createStructuredAgentSessionHostRequestFailures(
  sessions: Map<string, StructuredAgentSessionHostSession>,
  deps: () => StructuredAgentSessionHostDeps
): StructuredAgentSessionRequestFailures {
  return new StructuredAgentSessionRequestFailures({
    sessions,
    onFailure: (failure) => deps().onRequestFailure?.(failure),
    capturePendingOutput: (input) => deps().adapter.capturePendingOutput?.(input),
    wordsContext: (sessionId) =>
      structuredAgentSessionFailureWordsContext(
        deps().store.getRecord(sessionId),
        sessions.get(sessionId)?.journal
      )
  })
}
