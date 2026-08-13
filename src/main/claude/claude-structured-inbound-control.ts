import type { ClaudeControlRequest, ClaudeControlResponder } from './claude-stream-json-connection'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export const CLAUDE_CAN_USE_TOOL_SUBTYPE = 'can_use_tool'
export const CLAUDE_REQUEST_USER_DIALOG_SUBTYPE = 'request_user_dialog'
export const CLAUDE_BLOCKING_CONTROL_REQUEST_SUBTYPES = [
  CLAUDE_CAN_USE_TOOL_SUBTYPE,
  CLAUDE_REQUEST_USER_DIALOG_SUBTYPE
] as const

export type ClaudeInboundControlDisposition =
  | { kind: 'prompt' }
  | { kind: 'responded'; subtype: string }

export function handleClaudeInboundControlCancel(input: {
  sessionId: string
  attempt: ClaudeAcquisitionAttempt
  requestId: string
  emit: (event: ClaudeStructuredSessionEvent) => void
}): void {
  const prompt = input.attempt.prompts.cancel(input.requestId)
  input.emit(
    prompt
      ? {
          type: 'prompt-cancelled',
          sessionId: input.sessionId,
          promptKey: prompt.promptKey
        }
      : {
          type: 'provider-frame',
          sessionId: input.sessionId,
          kind: 'control_cancel_request',
          payload: { request_id: input.requestId }
        }
  )
}

/** Every Claude control request becomes a durable prompt or receives a safe reply. */
export function handleClaudeInboundControl(input: {
  sessionId: string
  attempt: ClaudeAcquisitionAttempt
  request: ClaudeControlRequest
  responder?: ClaudeControlResponder
  emit: (event: ClaudeStructuredSessionEvent) => void
}): ClaudeInboundControlDisposition {
  const responder = input.responder ?? input.attempt.connection
  const subtype = input.request.request.subtype
  if (subtype === CLAUDE_REQUEST_USER_DIALOG_SUBTYPE) {
    void responder?.respond(input.request.request_id, { behavior: 'cancelled' }).catch(() => {})
    input.emit({
      type: 'provider-frame',
      sessionId: input.sessionId,
      kind: `control_request:${subtype}`,
      payload: input.request.request
    })
    return { kind: 'responded', subtype }
  }
  const prompt = input.attempt.prompts.register(input.request)
  if (prompt) {
    input.emit({ type: 'prompt', sessionId: input.sessionId, prompt })
    return { kind: 'prompt' }
  }
  if (subtype === CLAUDE_CAN_USE_TOOL_SUBTYPE) {
    const toolUseId =
      typeof input.request.request.tool_use_id === 'string'
        ? input.request.request.tool_use_id
        : undefined
    void responder
      ?.respond(input.request.request_id, {
        behavior: 'deny',
        message: 'Orca could not decode this permission request.',
        ...(toolUseId ? { toolUseID: toolUseId } : {})
      })
      .catch(() => {})
  } else {
    void responder
      ?.respondWithError(input.request.request_id, `Orca does not handle ${subtype}`)
      .catch(() => {})
  }
  input.emit({
    type: 'provider-frame',
    sessionId: input.sessionId,
    kind: `control_request:${subtype}`,
    payload: input.request.request
  })
  return { kind: 'responded', subtype }
}
