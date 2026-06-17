import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusForwardEvent, MatrixForwardSettings } from './system-message-forwarder'

const sendToRoom = vi.fn(async (_body: string, _opts?: unknown) => ({
  ok: true as const,
  eventId: '$e'
}))

vi.mock('./matrix-service', () => ({
  getMatrixService: () => ({ sendToRoom })
}))
vi.mock('./session-handle-registry', () => ({
  handleForPaneKey: (paneKey: string) => `h-${paneKey}`
}))

import { forwardAgentStatusToMatrix, resetForwarderStateForTests } from './system-message-forwarder'

function event(
  state: AgentStatusForwardEvent['payload']['state'],
  extra: Partial<AgentStatusForwardEvent['payload']> = {},
  paneKey = 'tab:leaf'
): AgentStatusForwardEvent {
  return { paneKey, payload: { state, ...extra } }
}

const ALL_ON: MatrixForwardSettings = {
  matrixEnabled: true,
  matrixForwardSystemMessages: true,
  matrixForwardAgentStatus: true,
  matrixForwardErrors: true
}

describe('forwardAgentStatusToMatrix', () => {
  beforeEach(() => {
    sendToRoom.mockClear()
    resetForwarderStateForTests()
  })

  it('does nothing when Matrix is disabled, even with forward flags on', () => {
    forwardAgentStatusToMatrix(
      {
        matrixEnabled: false,
        matrixForwardSystemMessages: true,
        matrixForwardAgentStatus: true
      },
      event('working')
    )
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('does nothing when the master switch is off', () => {
    forwardAgentStatusToMatrix(
      { matrixEnabled: true, matrixForwardSystemMessages: false },
      event('working')
    )
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('forwards a routine status transition with the session-handle prefix', () => {
    forwardAgentStatusToMatrix(ALL_ON, event('working', { agentType: 'claude' }))
    expect(sendToRoom).toHaveBeenCalledTimes(1)
    expect(sendToRoom.mock.calls[0][0]).toContain('[orca h-tab:leaf]')
    expect(sendToRoom.mock.calls[0][0]).toContain('working')
  })

  it('dedupes repeated identical states', () => {
    forwardAgentStatusToMatrix(ALL_ON, event('working'))
    forwardAgentStatusToMatrix(ALL_ON, event('working'))
    expect(sendToRoom).toHaveBeenCalledTimes(1)
  })

  it('forwards again after the state changes', () => {
    forwardAgentStatusToMatrix(ALL_ON, event('working'))
    forwardAgentStatusToMatrix(ALL_ON, event('done'))
    expect(sendToRoom).toHaveBeenCalledTimes(2)
  })

  it('routes attention states (blocked) through the errors flag, not the status flag', () => {
    forwardAgentStatusToMatrix(
      {
        matrixEnabled: true,
        matrixForwardSystemMessages: true,
        matrixForwardAgentStatus: true,
        matrixForwardErrors: false
      },
      event('blocked')
    )
    expect(sendToRoom).not.toHaveBeenCalled()

    forwardAgentStatusToMatrix(
      {
        matrixEnabled: true,
        matrixForwardSystemMessages: true,
        matrixForwardAgentStatus: false,
        matrixForwardErrors: true
      },
      event('blocked')
    )
    expect(sendToRoom).toHaveBeenCalledTimes(1)
  })

  it('treats an interrupted done as an attention signal', () => {
    forwardAgentStatusToMatrix(
      {
        matrixEnabled: true,
        matrixForwardSystemMessages: true,
        matrixForwardAgentStatus: false,
        matrixForwardErrors: true
      },
      event('done', { interrupted: true })
    )
    expect(sendToRoom).toHaveBeenCalledTimes(1)
    expect(sendToRoom.mock.calls[0][0]).toContain('interrupted')
  })

  it('does not forward routine status when only the errors flag is on', () => {
    forwardAgentStatusToMatrix(
      {
        matrixEnabled: true,
        matrixForwardSystemMessages: true,
        matrixForwardAgentStatus: false,
        matrixForwardErrors: true
      },
      event('working')
    )
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('mirrors the assistant-message summary below the status line on done', () => {
    forwardAgentStatusToMatrix(
      ALL_ON,
      event('done', { agentType: 'claude', lastAssistantMessage: 'Fixed the auth bug.' })
    )
    expect(sendToRoom).toHaveBeenCalledTimes(1)
    const body = sendToRoom.mock.calls[0][0]
    expect(body).toContain('[orca h-tab:leaf] claude finished')
    expect(body).toContain('\nFixed the auth bug.')
  })

  it('includes the summary on a blocked attention state', () => {
    forwardAgentStatusToMatrix(
      { matrixEnabled: true, matrixForwardSystemMessages: true, matrixForwardErrors: true },
      event('blocked', { lastAssistantMessage: 'Which environment should I deploy to?' })
    )
    expect(sendToRoom.mock.calls[0][0]).toContain('Which environment should I deploy to?')
  })

  it('omits the summary on working (transient tool activity, not a summary)', () => {
    forwardAgentStatusToMatrix(
      ALL_ON,
      event('working', { agentType: 'claude', lastAssistantMessage: 'partial streamed text' })
    )
    const body = sendToRoom.mock.calls[0][0]
    expect(body).not.toContain('partial streamed text')
    expect(body).not.toContain('\n')
  })

  it('truncates an overlong summary with an ellipsis', () => {
    const long = 'x'.repeat(5000)
    forwardAgentStatusToMatrix(ALL_ON, event('done', { lastAssistantMessage: long }))
    const body = sendToRoom.mock.calls[0][0]
    // Status line + handle prefix + a bounded summary, not the full 5000 chars.
    expect(body.length).toBeLessThan(1700)
    expect(body.endsWith('…')).toBe(true)
  })
})
