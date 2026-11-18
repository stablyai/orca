import { expect, it } from 'vitest'
import { wslHookRelayConnectionId } from '../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { resumedAcceptedTurn } from './pane-agent-turn-continuity'
import type { EnrichedAgentHookEventPayload } from './server-types'

const WORKTREE = 'repo::\\\\wsl.localhost\\Ubuntu\\home\\u\\wt'
const SESSION = { key: 'session_id', id: 'claude-session' } as const

// A woken row: the resumed conversation's accepted verdict, stamped by its launch.
const resumed: EnrichedAgentHookEventPayload = {
  paneKey: 'tab-1:pane',
  tabId: 'tab-1',
  worktreeId: WORKTREE,
  connectionId: wslHookRelayConnectionId('Ubuntu'),
  receivedAt: 1_000,
  stateStartedAt: 1_000,
  turnEndedAt: 1_000,
  providerSession: SESSION,
  observation: {
    origin: 'launch',
    authorityId: 'main',
    incarnation: 1,
    revision: 1,
    observedAt: 2_000
  },
  payload: { state: 'done', prompt: 'Finished work', agentType: 'claude' }
}
const restated = {
  paneKey: 'tab-1:pane',
  tabId: 'tab-1',
  worktreeId: WORKTREE,
  connectionId: null,
  providerSession: SESSION,
  payload: { state: 'done', prompt: '', agentType: 'claude' }
} as const

it('keeps a restated verdict on the reporting terminal, but not a later stamped turn end', () => {
  expect(resumedAcceptedTurn(resumed, restated, 'osc')).toMatchObject({
    connectionId: null,
    payload: { prompt: 'Finished work' }
  })
  expect(resumedAcceptedTurn(resumed, { ...restated, turnEndedAt: 3_000 }, 'osc')).toBeNull()
})
