import { describe, expect, it } from 'vitest'
import { claudeChildOperation } from './claude-child-work-evidence'

describe('Claude child operation evidence', () => {
  it("carries the model the subagent's own message ran on", () => {
    const frame = {
      type: 'assistant',
      session_id: 'provider-1',
      uuid: 'uuid-1',
      parent_tool_use_id: 'toolu_spawn',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]
      }
    }
    const evidence = claudeChildOperation(
      frame,
      () => ({ agentId: 'agent-1', openTool: null }),
      100
    )
    expect(evidence).toEqual([
      expect.objectContaining({ type: 'operation', childId: 'agent-1', model: 'claude-sonnet-5-5' })
    ])
  })
})
