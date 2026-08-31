import type { ClaudeStreamJsonConnectionHandlers } from './claude-stream-json-connection'
import {
  handleClaudeInboundControl,
  handleClaudeInboundControlCancel
} from './claude-structured-inbound-control'
import type { ClaudeInitDeadline } from './claude-structured-init-deadline'
import { readClaudeFrameString, readClaudeInit } from './claude-structured-init-proof'
import {
  applyClaudeSessionMessageIdentity,
  type ClaudeRetiredSentUserUuids
} from './claude-owned-turn-receipts'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export function createClaudeAcquisitionConnectionHandlers(input: {
  sessionId: string
  attempt: ClaudeAcquisitionAttempt
  generation: object
  initDeadline: ClaudeInitDeadline
  retiredSentUserUuids: ClaudeRetiredSentUserUuids
  isCurrentAttempt: () => boolean
  getLiveSession: () => ClaudeSession | null
  isCurrentSession: (session: ClaudeSession) => boolean
  observeLeafUuid: (uuid: string | null) => void
  deliver: (event: () => void) => void
  emit: (event: ClaudeStructuredSessionEvent, translate?: boolean) => void
  onExit: (error: Error) => void
}): ClaudeStreamJsonConnectionHandlers {
  const { sessionId, attempt } = input
  return {
    onMessage: (message) => {
      const init = readClaudeInit(message)
      if (init) {
        input.initDeadline.resolve(init)
      }
      const uuid = readClaudeFrameString(message, 'uuid')
      const retiredOwnedUuid =
        !init && uuid ? input.retiredSentUserUuids.has(sessionId, uuid) : false
      if (
        !retiredOwnedUuid &&
        !attempt.published &&
        !attempt.cancelled &&
        input.isCurrentAttempt()
      ) {
        input.observeLeafUuid(uuid)
      }
      input.deliver(() => {
        const session = input.getLiveSession()
        if (
          !session ||
          !input.isCurrentSession(session) ||
          session.generation !== input.generation
        ) {
          return
        }
        const translate = applyClaudeSessionMessageIdentity({
          session,
          message,
          uuid,
          retiredOwnedUuid
        })
        input.observeLeafUuid(session.leafUuid)
        input.emit({ type: 'message', sessionId, message }, translate)
      })
    },
    onControlRequest: (request, responder) => {
      handleClaudeInboundControl({
        sessionId,
        attempt,
        request,
        responder,
        emit: (event) => input.deliver(() => input.emit(event))
      })
    },
    onControlCancelRequest: ({ request_id: requestId }) => {
      handleClaudeInboundControlCancel({
        sessionId,
        attempt,
        requestId,
        emit: (event) => input.deliver(() => input.emit(event))
      })
    },
    onExit: (error) => {
      if (!attempt.published) {
        input.initDeadline.reject(error)
      }
      input.onExit(error)
    }
  }
}

export function emitClaudeSessionEvent(
  session: ClaudeSession | null,
  onEvent: ((event: ClaudeStructuredSessionEvent) => void) | undefined,
  event: ClaudeStructuredSessionEvent,
  translate = true
): void {
  if (translate) {
    session?.translator?.handle(event)
  }
  onEvent?.(event)
}
