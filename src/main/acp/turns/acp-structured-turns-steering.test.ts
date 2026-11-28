import { expect, it, vi } from 'vitest'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'
import { AcpStructuredLane } from '../journal/acp-structured-lane'
import { AcpStructuredTurns } from './acp-structured-turns'

it('injects mail when journal backpressure releases the already running prompt turn', async () => {
  let blocked = true
  const lane = new AcpStructuredLane({
    sink: {
      tryAppendTransition: () =>
        blocked ? { accepted: false, reason: 'backpressure' } : { accepted: true }
    },
    sessionId: 'chat',
    providerSessionId: 'omp-session',
    agent: 'omp',
    agentName: 'OMP',
    generation: 'generation',
    dialect: OMP_ACP_DIALECT,
    logger: createStructuredAgentSessionLogger(),
    onInputAccepted: (id) => turns.accept(id),
    onFailed: (reason) => {
      throw new Error(reason)
    }
  })
  const first = Promise.withResolvers<{ stopReason: 'end_turn' }>()
  const prompt = vi.fn(() => first.promise)
  const cancel = vi.fn(async () => {})
  const requestExtension = vi.fn(async () => ({ outcome: 'injected' }))
  const settle = vi.fn()
  const turns = new AcpStructuredTurns({
    connection: { prompt, cancel, requestExtension },
    lane,
    steeringSessionId: 'omp-session',
    withdrawRequests: () => {},
    agentName: 'OMP',
    now: () => 3,
    settle,
    sessionLost: (error) => {
      throw error
    }
  })
  try {
    turns.dispatch(
      { clientMessageId: 'work', requestedAt: 1, prompt: [{ type: 'text', text: 'Keep working' }] },
      'cancel'
    )
    const text = 'Use the new instructions'
    turns.dispatch(
      { clientMessageId: 'mail', requestedAt: 2, prompt: [{ type: 'text', text }] },
      'mail'
    )
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(requestExtension).not.toHaveBeenCalled()

    blocked = false
    lane.retry()
    await vi.waitFor(() =>
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({
          clientMessageId: 'mail',
          answeredInTurn: { via: 'steer', turn: lane.promptTurnIdentity('work') }
        })
      )
    )
    expect(requestExtension).toHaveBeenCalledExactlyOnceWith('_session/steering', {
      sessionId: 'omp-session',
      prompt: [{ type: 'text', text }]
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
  } finally {
    first.resolve({ stopReason: 'end_turn' })
    await first.promise
    lane.dispose()
  }
})
