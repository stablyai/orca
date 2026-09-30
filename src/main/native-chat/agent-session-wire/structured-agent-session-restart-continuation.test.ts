import { expect, it, vi } from 'vitest'
import { marker, SESSION } from './structured-agent-session-restart-resume-test-harness'
import {
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import {
  RestartContinuationSupersededError,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationDeps
} from './structured-agent-session-restart-continuation'

/** The whole continuation: handed over, then its verdict. */
async function continueStructuredAgentSessionAfterRestart(
  ...args: Parameters<typeof startStructuredAgentSessionContinuation>
) {
  const started = await startStructuredAgentSessionContinuation(...args)
  return 'done' in started ? started.done : started.verdict()
}

function dependencies(
  settledDispatch: 'accepted' | 'pending' | 'unknown' | 'rejected',
  handedOver: 'pending' | 'rejected' | undefined = 'pending'
): StructuredAgentSessionContinuationDeps & {
  note: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  return {
    currentFence: () => 1,
    send: vi.fn(async () => ({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })),
    awaitSettlement: vi.fn(async () => ({
      dispatchState: settledDispatch,
      reason: settledDispatch === 'rejected' ? 'provider_refused' : null
    })),
    awaitHandedOver: vi.fn(async () =>
      handedOver
        ? {
            dispatchState: handedOver,
            reason: handedOver === 'rejected' ? 'Codex could not start.' : null
          }
        : undefined
    ),
    note: vi.fn(async () => undefined),
    onNoteFailed: vi.fn()
  }
}

it('reports an accepted continuation and records its note', async () => {
  const deps = dependencies('accepted')

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).resolves.toEqual({
    sessionId: SESSION,
    outcome: 'continued'
  })
  expect(deps.note).toHaveBeenCalledOnce()
})

const UNCONFIRMED = [SESSION, AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE, 'warning']
const REFUSED = [SESSION, AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE, 'error']
const NOT_CONNECTED = [SESSION, AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE, 'error']

it.each([
  ['pending', { sessionId: SESSION, outcome: 'pending' }, UNCONFIRMED],
  ['unknown', { sessionId: SESSION, outcome: 'unknown' }, UNCONFIRMED],
  ['rejected', { sessionId: SESSION, outcome: 'refused', reason: 'provider_refused' }, REFUSED]
] as const)(
  'preserves a %s settlement and notes it in the chat instead of the success note',
  async (settled, expected, note) => {
    const deps = dependencies(settled)

    await expect(
      continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
    ).resolves.toEqual(expected)
    expect(deps.note).toHaveBeenCalledExactlyOnceWith(...note)
  }
)

it("writes nothing in the chat when the user's own message came first, and still refuses", async () => {
  const deps = dependencies('accepted')
  deps.send.mockRejectedValue(new RestartContinuationSupersededError())

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).rejects.toBeInstanceOf(RestartContinuationSupersededError)
  expect(deps.note).not.toHaveBeenCalled()
})

// An ownership refusal would meet the user's own message too, so the note gives no advice to send one.
it.each([
  ['agent_session_conflict', NOT_CONNECTED],
  ['agent_session_operation_invalid', REFUSED]
] as const)('reports a %s send refusal without waiting for settlement', async (code, note) => {
  const deps = dependencies('accepted')
  deps.send.mockResolvedValue({ ok: false, refusal: { code } })

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).resolves.toEqual({
    sessionId: SESSION,
    outcome: 'refused',
    reason: code
  })
  expect(deps.awaitSettlement).not.toHaveBeenCalled()
  expect(deps.note).toHaveBeenCalledExactlyOnceWith(...note)
})

it('reports an unattached chat without sending', async () => {
  const deps = dependencies('accepted')
  deps.currentFence = () => null

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).resolves.toEqual({
    sessionId: SESSION,
    outcome: 'refused',
    reason: 'agent_session_not_attached'
  })
  expect(deps.send).not.toHaveBeenCalled()
})

// A start that failed rejects the continuation before any provider saw it: that is the verdict.
it('reports a continuation rejected at handover without waiting for the provider', async () => {
  const deps = dependencies('accepted', 'rejected')

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).resolves.toEqual({ sessionId: SESSION, outcome: 'refused', reason: 'Codex could not start.' })
  expect(deps.awaitSettlement).not.toHaveBeenCalled()
  expect(deps.note).toHaveBeenCalledExactlyOnceWith(...REFUSED)
})

// The start completes once the agent took the message; the provider's answer is a later verdict.
it('returns at handover and leaves the provider verdict to be awaited', async () => {
  const deps = dependencies('accepted')

  const started = await startStructuredAgentSessionContinuation(
    deps,
    SESSION,
    marker(),
    'operation-1'
  )

  expect(deps.awaitHandedOver).toHaveBeenCalledOnce()
  expect(deps.awaitSettlement).not.toHaveBeenCalled()
  if (!('verdict' in started)) {
    throw new Error('expected a handed-over continuation')
  }
  await expect(started.verdict()).resolves.toEqual({ sessionId: SESSION, outcome: 'continued' })
  expect(deps.note).toHaveBeenCalledOnce()
})

// A handover wait that ends without an answer — the session closed, or too many waited — proves
// nothing, so the provider's verdict still decides.
it('still awaits the verdict when the handover wait ends unanswered', async () => {
  const deps = dependencies('unknown', undefined)

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker(), 'operation-1')
  ).resolves.toEqual({ sessionId: SESSION, outcome: 'unknown' })
  expect(deps.note).toHaveBeenCalledExactlyOnceWith(...UNCONFIRMED)
})
