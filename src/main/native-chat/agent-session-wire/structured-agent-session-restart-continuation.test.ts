import { expect, it, vi } from 'vitest'
import { marker, SESSION } from './structured-agent-session-restart-resume-test-harness'
import {
  continueStructuredAgentSessionAfterRestart,
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

it.each([
  ['pending', { sessionId: SESSION, outcome: 'pending' }],
  ['unknown', { sessionId: SESSION, outcome: 'unknown' }],
  ['rejected', { sessionId: SESSION, outcome: 'refused', reason: 'provider_refused' }]
] as const)(
  'preserves a %s settlement without recording a success note',
  async (settled, expected) => {
    const deps = dependencies(settled)

    await expect(
      continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
    ).resolves.toEqual(expected)
    expect(deps.note).not.toHaveBeenCalled()
  }
)

it('reports a send refusal without waiting for settlement', async () => {
  const deps = dependencies('accepted')
  deps.send.mockResolvedValue({ ok: false, refusal: { code: 'agent_session_conflict' } })

  await expect(
    continueStructuredAgentSessionAfterRestart(deps, SESSION, marker())
  ).resolves.toEqual({
    sessionId: SESSION,
    outcome: 'refused',
    reason: 'agent_session_conflict'
  })
  expect(deps.awaitSettlement).not.toHaveBeenCalled()
  expect(deps.note).not.toHaveBeenCalled()
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
