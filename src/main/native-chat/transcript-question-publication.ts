import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../shared/agent-session-current-requests-capability'
import {
  currentRequestsProjection,
  unavailableCurrentRequestsProjection,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import type { MessageQuestionIngest } from './message-question-ingest'

export function createTranscriptQuestionPublication(sourceId: string, sessionId: string) {
  const owner = {}
  const blocking: [] = []
  let projection = unavailableCurrentRequestsProjection(
    owner,
    sessionId,
    AGENT_SESSION_CURRENT_REQUESTS_V2,
    sourceId
  )
  let pending: ReturnType<MessageQuestionIngest['current']>['pending'] | null | undefined
  const listeners = new Set<(projection: CurrentRequestsProjection) => void>()
  function publish(
    snapshot: ReturnType<MessageQuestionIngest['current']> | null,
    context: string
  ): void {
    const boundary = JSON.stringify([sourceId, context])
    if (
      pending === (snapshot?.pending ?? null) &&
      projection.marker.owner === `${projection.identity}:${boundary}`
    ) {
      return
    }
    pending = snapshot?.pending ?? null
    projection = currentRequestsProjection(
      owner,
      sessionId,
      { actionablePrompts: () => blocking, viewKey: () => boundary },
      AGENT_SESSION_CURRENT_REQUESTS_V2,
      { blocking, asyncQuestions: pending, context: { sessionId, boundary } },
      sourceId
    )
    listeners.forEach((notify) => notify(projection))
  }
  function unavailable(contextVerified: boolean, context: string): void {
    if (contextVerified) {
      publish(null, context)
      return
    }
    const next = unavailableCurrentRequestsProjection(
      owner,
      sessionId,
      AGENT_SESSION_CURRENT_REQUESTS_V2,
      sourceId
    )
    pending = undefined
    if (projection !== next) {
      projection = next
      listeners.forEach((notify) => notify(next))
    }
  }
  return { publish, unavailable, listeners, current: () => projection }
}
