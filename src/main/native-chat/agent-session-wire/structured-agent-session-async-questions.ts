import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'
import type {
  StructuredAgentSessionCurrentWork,
  StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import { prepareStructuredQuestions } from './structured-agent-session-question-projection'

export function structuredAsyncQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string,
  work: StructuredAgentSessionCurrentWork
): CurrentRequestsPayload {
  const blocking = work.actionablePrompts()
  const { attempt, prior } = prepareStructuredQuestions(journal, sessionId)
  let pending: CurrentRequestsPayload['asyncQuestions'] = null
  try {
    // Retain the attempt before preparation and ingest before any fallible creation/settlement.
    if (attempt.nextAttempt === undefined || Date.now() >= attempt.nextAttempt) {
      attempt.ingest ??= attempt.prepare()
      pending = attempt.ingest.current().pending
      attempt.nextAttempt = undefined
    }
  } catch {
    // Async acquisition does not take down healthy blocking/history/lifecycle delivery.
    attempt.nextAttempt = Date.now() + 750
  }
  if (attempt.payload?.blocking === blocking && attempt.payload.asyncQuestions === pending) {
    return attempt.payload
  }
  const payload: CurrentRequestsPayload = {
    blocking,
    asyncQuestions: pending,
    context: { sessionId, boundary: attempt.context }
  }
  const json = JSON.stringify(payload)
  const stable = prior?.json === json && prior.payload ? prior.payload : payload
  attempt.payload = stable
  attempt.json = json
  return stable
}

export function cancelStructuredAsyncQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string,
  _work: StructuredAgentSessionCurrentWork,
  ids: readonly string[],
  caller: string,
  now: number
): boolean {
  const { attempt: projection } = prepareStructuredQuestions(journal, sessionId)
  projection.ingest ??= projection.prepare()
  return projection.ingest.cancel(ids, caller, now).length > 0
}
