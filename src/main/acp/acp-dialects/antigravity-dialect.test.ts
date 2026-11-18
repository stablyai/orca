import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

describe('Antigravity swarm dialect hooks', () => {
  it('maps swarm add/kill tool calls into subagent updates', () => {
    expect(
      ANTIGRAVITY_ACP_DIALECT.toolSubagents?.(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_add',
          rawInput: { action: 'add', name: 'backend-dev', role: 'worker' }
        },
        {
          kind: 'tool-call',
          callId: 'call_add',
          name: 'swarm',
          input: { action: 'add', name: 'backend-dev', role: 'worker' },
          state: 'running'
        }
      )
    ).toEqual([{ id: 'backend-dev', label: 'backend-dev', state: 'working' }])

    expect(
      ANTIGRAVITY_ACP_DIALECT.toolSubagents?.(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_add_fail',
          status: 'failed',
          rawInput: { action: 'add', name: 'backend-dev', role: 'worker' }
        },
        {
          kind: 'tool-call',
          callId: 'call_add_fail',
          name: 'swarm',
          input: { action: 'add', name: 'backend-dev', role: 'worker' },
          state: 'failed'
        }
      )
    ).toEqual([{ id: 'backend-dev', label: 'backend-dev', state: 'failed' }])

    expect(
      ANTIGRAVITY_ACP_DIALECT.toolSubagents?.(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_kill',
          status: 'completed',
          rawInput: { action: 'kill', name: 'backend-dev' }
        },
        {
          kind: 'tool-call',
          callId: 'call_kill',
          name: 'swarm',
          input: { action: 'kill', name: 'backend-dev' },
          state: 'completed'
        }
      )
    ).toEqual([{ id: 'backend-dev', state: 'stopped' }])
  })

  it('keeps concise tool names for swarm actions', () => {
    expect(
      ANTIGRAVITY_ACP_DIALECT.toolName?.({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_post',
        title: 'swarm_post_message: @all review ready',
        rawInput: { text: '@all review ready' }
      })
    ).toBe('swarm_post_message')
  })
})
