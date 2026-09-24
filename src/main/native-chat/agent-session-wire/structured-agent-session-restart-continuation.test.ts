import { expect, it, vi } from 'vitest'
import { marker, SESSION } from './structured-agent-session-restart-resume-test-harness'
import {
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import {
  continueStructuredAgentSessionAfterRestart,
  RestartContinuationSupersededError,
  type StructuredAgentSessionContinuationDeps
} from './structured-agent-session-restart-continuation'

function dependencies(
  settledDispatch: 'accepted' | 'pending' | 'unknown' | 'rejected'
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
    note: vi.fn(async () => undefined),
    onNoteFailed: vi.fn()
  }
}

it('reports an accepted continuation and records its note', async () => {
  const deps = dependencies('accepted')

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
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
      continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
    ).resolves.toEqual(expected)
    expect(deps.note).toHaveBeenCalledExactlyOnceWith(...note)
  }
)

it('notes a superseded continuation in the chat and still reports the refusal', async () => {
  const deps = dependencies('accepted')
  deps.send.mockRejectedValue(new RestartContinuationSupersededError())

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
  ).rejects.toBeInstanceOf(RestartContinuationSupersededError)
  expect(deps.note).toHaveBeenCalledExactlyOnceWith(...REFUSED)
})

// An ownership refusal would meet the user's own message too, so the note gives no advice to send one.
it.each([
  ['agent_session_conflict', NOT_CONNECTED],
  ['agent_session_operation_invalid', REFUSED]
] as const)('reports a %s send refusal without waiting for settlement', async (code, note) => {
  const deps = dependencies('accepted')
  deps.send.mockResolvedValue({ ok: false, refusal: { code } })

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
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
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
  ).resolves.toEqual({
    sessionId: SESSION,
    outcome: 'refused',
    reason: 'agent_session_not_attached'
  })
  expect(deps.send).not.toHaveBeenCalled()
})
