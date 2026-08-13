import { describe, expect, it, vi } from 'vitest'
import { createClaudeAcquisitionAttempt } from './claude-structured-session-state'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import {
  CLAUDE_BLOCKING_CONTROL_REQUEST_SUBTYPES,
  CLAUDE_CAN_USE_TOOL_SUBTYPE,
  CLAUDE_REQUEST_USER_DIALOG_SUBTYPE,
  handleClaudeInboundControl
} from './claude-structured-inbound-control'

function rejectingAttempt() {
  const attempt = createClaudeAcquisitionAttempt(new ClaudePromptRegistry())
  const respond = vi.fn().mockRejectedValue(new Error('connection closed'))
  const respondWithError = vi.fn().mockRejectedValue(new Error('connection closed'))
  attempt.connection = { respond, respondWithError } as never
  return { attempt, respond, respondWithError }
}

describe('Claude inbound control', () => {
  it('routes a valid permission request to the durable prompt registry', () => {
    const control = rejectingAttempt()
    const emit = vi.fn()

    expect(
      handleClaudeInboundControl({
        sessionId: 'session-1',
        attempt: control.attempt,
        request: {
          type: 'control_request',
          request_id: 'permission-1',
          request: {
            subtype: CLAUDE_CAN_USE_TOOL_SUBTYPE,
            tool_use_id: 'tool-1',
            tool_name: 'Bash',
            input: { command: 'git status' }
          }
        },
        emit
      })
    ).toEqual({ kind: 'prompt' })
    expect(control.respond).not.toHaveBeenCalled()
    expect(control.respondWithError).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }))
  })

  it('denies a malformed permission request with a protocol response', () => {
    const control = rejectingAttempt()

    expect(
      handleClaudeInboundControl({
        sessionId: 'session-1',
        attempt: control.attempt,
        request: {
          type: 'control_request',
          request_id: 'permission-2',
          request: { subtype: CLAUDE_CAN_USE_TOOL_SUBTYPE, tool_use_id: 'tool-2' }
        },
        emit: vi.fn()
      })
    ).toEqual({ kind: 'responded', subtype: CLAUDE_CAN_USE_TOOL_SUBTYPE })
    expect(control.respond).toHaveBeenCalledWith('permission-2', {
      behavior: 'deny',
      message: 'Orca could not decode this permission request.',
      toolUseID: 'tool-2'
    })
  })

  it('consumes rejected writes while declining unsupported controls', async () => {
    const dialog = rejectingAttempt()
    handleClaudeInboundControl({
      sessionId: 'session-1',
      attempt: dialog.attempt,
      request: {
        type: 'control_request',
        request_id: 'dialog-1',
        request: { subtype: 'request_user_dialog' }
      },
      emit: vi.fn()
    })
    const unsupported = rejectingAttempt()
    handleClaudeInboundControl({
      sessionId: 'session-1',
      attempt: unsupported.attempt,
      request: {
        type: 'control_request',
        request_id: 'control-1',
        request: { subtype: 'future_control' }
      },
      emit: vi.fn()
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(dialog.respond).toHaveBeenCalledWith('dialog-1', { behavior: 'cancelled' })
    expect(unsupported.respondWithError).toHaveBeenCalledWith(
      'control-1',
      'Orca does not handle future_control'
    )
  })

  it('enumerates every blocking control request in the stable stream-json surface', () => {
    expect(new Set(CLAUDE_BLOCKING_CONTROL_REQUEST_SUBTYPES)).toEqual(
      new Set([CLAUDE_CAN_USE_TOOL_SUBTYPE, CLAUDE_REQUEST_USER_DIALOG_SUBTYPE])
    )
  })
})
