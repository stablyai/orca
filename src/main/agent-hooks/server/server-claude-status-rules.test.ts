import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { shouldKeepClaudePermissionVisible } from './server-claude-status-rules'

function hookRow(overrides: Partial<AgentHookEventPayload> = {}): EnrichedAgentHookEventPayload {
  return {
    paneKey: 'pane-1',
    connectionId: null,
    hookEventName: 'PermissionRequest',
    toolAgentId: 'child-1',
    payload: {
      paneKey: 'pane-1',
      connectionId: null,
      agentType: 'claude',
      state: 'waiting',
      toolName: 'Bash'
    },
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    ...overrides
  } as EnrichedAgentHookEventPayload
}

function workingFrame(): AgentHookEventPayload {
  return {
    paneKey: 'pane-1',
    connectionId: null,
    payload: {
      paneKey: 'pane-1',
      connectionId: null,
      agentType: 'claude',
      state: 'working',
      prompt: ''
    }
  } as AgentHookEventPayload
}

describe('shouldKeepClaudePermissionVisible', () => {
  it('keeps a child-owned permission wait held when only pane-level program work reports (#37011)', () => {
    // The fresh working frame passed the hook-silence gate, but the waiting row belongs to a
    // child agent: only that child's own settlement (turn-end/exit evidence below this branch)
    // may release it, not the pane-level report.
    expect(shouldKeepClaudePermissionVisible(hookRow(), workingFrame(), true)).toBe(true)
  })

  it('releases a pane-owned permission wait when the program resumes fresh work (#37003)', () => {
    const row = hookRow({ toolAgentId: undefined })
    delete row.toolAgentId
    expect(shouldKeepClaudePermissionVisible(row, workingFrame(), true)).toBe(false)
  })
})
