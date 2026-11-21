import { expect, it } from 'vitest'
import { paneAgentIdentity } from './pane-agent-identity'

it('ends a pane whose only report since the exit is a replay of older evidence', () => {
  const row = {
    paneKey: 'tab:1',
    worktreeId: 'wt',
    connectionId: null,
    receivedAt: 2_000,
    evidenceObservedAt: 1_000,
    stateStartedAt: 1_000,
    state: 'done',
    agentType: 'claude',
    prompt: ''
  } as const
  expect(paneAgentIdentity({ paneKey: 'tab:1', row, exitedAt: 1_500 })?.ended).toBe(true)
  expect(
    paneAgentIdentity({
      paneKey: 'tab:1',
      row: { ...row, evidenceObservedAt: 1_800 },
      exitedAt: 1_500
    })?.ended
  ).toBe(false)
})
