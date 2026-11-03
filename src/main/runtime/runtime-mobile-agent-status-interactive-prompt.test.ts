import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'

describe('selectRuntimeHookAgentRowForPane with aged interactive prompts', () => {
  it('retains live waiting and blocked rows with interactivePrompt past AGENT_STATUS_STALE_AFTER_MS', () => {
    const agedTime = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 60_000 // 31 minutes ago
    const prompt = JSON.stringify({
      approval: { tool: 'Bash', summary: 'gh pr comment' }
    })

    const payload: AgentStatusIpcPayload = {
      connectionId: 'conn-1',
      paneKey: 'pane-1',
      agentType: 'claude',
      prompt: '',
      state: 'waiting',
      stateStartedAt: agedTime,
      receivedAt: agedTime,
      evidenceObservedAt: agedTime,
      interactivePrompt: prompt,
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'gh pr comment 1' })
    }

    const selected = selectRuntimeHookAgentRowForPane([payload])
    expect(selected.agentType).toBe('claude')
    expect(selected.live).not.toBeNull()
    expect(selected.live?.payload.interactivePrompt).toBe(prompt)
    expect(selected.live?.payload.toolName).toBe('Bash')
  })

  it('drops rows past AGENT_STATUS_STALE_AFTER_MS without interactivePrompt', () => {
    const agedTime = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 60_000

    const payload: AgentStatusIpcPayload = {
      connectionId: 'conn-1',
      paneKey: 'pane-1',
      agentType: 'claude',
      prompt: '',
      state: 'waiting',
      stateStartedAt: agedTime,
      receivedAt: agedTime,
      evidenceObservedAt: agedTime
    }

    const selected = selectRuntimeHookAgentRowForPane([payload])
    expect(selected.agentType).toBeNull()
    expect(selected.live).toBeNull()
  })
})
