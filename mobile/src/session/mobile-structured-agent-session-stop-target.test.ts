import { beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { requestMobileStructuredAgentSessionCancel } from './mobile-structured-agent-session-cancel'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'

vi.mock('./mobile-structured-agent-session-rpc', () => ({
  requestStructuredAgentSessionMutation: vi.fn(async () => ({
    status: 'accepted',
    value: { cancelled: true }
  }))
}))

beforeEach(() => vi.clearAllMocks())

const client: RpcClient = {
  sendRequest: vi.fn(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

function stop(state: StructuredAgentSessionState, targetedStopSupported: boolean) {
  const onSendError = vi.fn()
  return {
    onSendError,
    result: requestMobileStructuredAgentSessionCancel({
      client,
      sessionId: 'phone-chat',
      enabled: true,
      stateRef: { current: state },
      promptCancelSupported: false,
      hostAnswersRepeatedStops: true,
      targetedStopSupported,
      inFlight: new Map(),
      onSendError
    })
  }
}

it.each([false, true])('keeps turn targets capability-gated: %s', async (supported) => {
  const state: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    fence: 1,
    latestTurn: {
      itemId: 'turn-item',
      observedAt: 1,
      turn: { turnId: 'one', state: 'running' }
    }
  }
  expect(await stop(state, supported).result).toBe(true)
  expect(vi.mocked(requestStructuredAgentSessionMutation).mock.calls[0]?.[0].fields).toEqual(
    supported ? { turnId: 'one', stopTarget: { kind: 'turn', turnId: 'one' } } : { turnId: 'one' }
  )
})

const pendingState: StructuredAgentSessionState = {
  ...EMPTY_STRUCTURED_AGENT_SESSION,
  fence: 1,
  submissions: [
    {
      clientMessageId: 'host-published-send',
      fence: 1,
      payloadFingerprint: 'fp',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }
  ]
}

it('stops the host-published unanswered submission before a turn opens', async () => {
  expect(isStructuredAgentSessionMainAgentWorking(null, pendingState.submissions, 1)).toBe(true)
  const request = stop(pendingState, true)
  expect(await request.result).toBe(true)
  expect(requestStructuredAgentSessionMutation).toHaveBeenCalledWith(
    expect.objectContaining({
      fields: { stopTarget: { kind: 'submission', clientMessageId: 'host-published-send' } }
    })
  )
  expect(request.onSendError).not.toHaveBeenCalled()
})

it('keeps the no-turn refusal and feedback for an older host', async () => {
  const request = stop(pendingState, false)
  expect(await request.result).toBe(false)
  expect(requestStructuredAgentSessionMutation).not.toHaveBeenCalled()
  expect(request.onSendError).toHaveBeenCalledWith('Stop not sent')
})

it.each([
  { ...pendingState, fence: 2 },
  { ...pendingState, fence: null },
  { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 1 }
])('does not invent a target without current unanswered work', async (state) => {
  const request = stop(state, true)
  expect(await request.result).toBe(false)
  expect(requestStructuredAgentSessionMutation).not.toHaveBeenCalled()
  expect(request.onSendError).toHaveBeenCalledWith('Stop not sent')
})
