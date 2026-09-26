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

// The mobile projection narrows a row through `pickParsedAgentStatusPayload`; this pins that
// the main agent fact survives the narrowing. The `worktree ps` row keeps its own explicit shape.
describe('the main agent fact through the runtime projections', () => {
  it('reaches the mobile live row', () => {
    const source = row()
    const selected = selectRuntimeHookAgentRowForPane([source])
    expect(selected.live?.payload.mainAgent).toEqual(source.mainAgent)
  })
})
