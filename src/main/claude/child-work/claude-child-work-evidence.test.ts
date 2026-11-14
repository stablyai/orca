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

  // A foreground subagent's roster line blinked out after every call it ran.
  it("keeps a returned call as the subagent's latest work until its next call", () => {
    const result = (toolUseId: string) => ({
      type: 'user',
      session_id: 'provider-1',
      uuid: `result-${toolUseId}`,
      parent_tool_use_id: 'toolu_spawn',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }]
      }
    })
    const idle = () => ({ agentId: 'agent-1', openTool: null })
    expect(claudeChildOperation(result('toolu_grep'), idle, 100)).toEqual([])

    const stillOpen = () => ({
      agentId: 'agent-1',
      openTool: { id: 'toolu_read', name: 'Read', input: { file_path: '/a.ts' } }
    })
    expect(claudeChildOperation(result('toolu_grep'), stillOpen, 100)).toEqual([
      expect.objectContaining({
        type: 'operation',
        childId: 'agent-1',
        operation: expect.objectContaining({ toolName: 'Read', basis: 'open' })
      })
    ])
  })
})
