import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../shared/agent-session-current-requests-capability'
import {
  currentRequestsProjection,
  unavailableCurrentRequestsProjection,
  type CurrentRequestsProjection
} from './agent-session-wire/agent-session-current-requests'
import type { MessageQuestionIngest } from './message-question-ingest'

export type TranscriptQuestionMaterialization = {
  materialized: boolean
  failure?: { error: unknown }
}

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
  function materialize(
    ingest: MessageQuestionIngest,
    contextVerified: boolean,
    context: string
  ): TranscriptQuestionMaterialization {
    try {
      publish(ingest.current(), context)
      return { materialized: true }
    } catch (error) {
      try {
        unavailable(contextVerified, context)
      } catch {
        // A subscriber failure cannot revoke source admission or a committed target receipt.
      }
      return { materialized: false, failure: { error } }
    }
  }
  return { materialize, publish, unavailable, listeners, current: () => projection }
}
