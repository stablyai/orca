import { StructuredAgentSessionRequestFailures } from './structured-agent-session-request-failures'
import { readStructuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

export function createStructuredAgentSessionHostRequestFailures(
  sessions: Map<string, StructuredAgentSessionHostSession>,
  deps: () => StructuredAgentSessionHostDeps
): StructuredAgentSessionRequestFailures {
  return new StructuredAgentSessionRequestFailures({
    sessions,
    onError: (error) =>
      deps().logger.warn('observing ended requests failed', { scope: 'request-outcomes', error }),
    onFailure: (failure) => deps().onRequestFailure?.(failure),
    capturePendingOutput: (input) => deps().adapter.capturePendingOutput?.(input),
    wordsContext: (sessionId) =>
      readStructuredAgentSessionFailureWordsContext(
        deps().store.getRecord(sessionId),
        sessions.get(sessionId)?.journal
      )
  })
}
