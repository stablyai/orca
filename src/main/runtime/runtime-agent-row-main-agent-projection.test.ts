import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(over: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    receivedAt: now,
    stateStartedAt: now - 1_000,
    state: 'working',
    prompt: 'ship it',
    agentType: 'claude',
    mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: now - 2_000 },
    ...over
  }
}

// Pin main-agent facts through mobile's pickParsedAgentStatusPayload narrowing; worktree ps builds its own shape.
describe('the main agent fact through the runtime projections', () => {
  it('reaches the mobile live row', () => {
    const source = row()
    const selected = selectRuntimeHookAgentRowForPane([source])
    expect(selected.live?.payload.mainAgent).toEqual(source.mainAgent)
  })
})
