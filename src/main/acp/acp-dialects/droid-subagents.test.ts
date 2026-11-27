import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import { DROID_ACP_DIALECT } from './droid-dialect'

// Update shapes are Droid 1.17.2's (`droid exec --output-format acp`): every update names the tool.
function droidSession() {
  const lane = new AcpTimelineTranslator({ sessionId: 'droid', dialect: DROID_ACP_DIALECT })
  const task = (update: Record<string, unknown>, at: number): void => {
    lane.notification(
      'session/update',
      {
        sessionId: 'droid',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', name: 'Task', ...update }
      },
      at
    )
  }
  const states = (): string[] =>
    lane.subagents
      .drainEvidence()
      .map((edge: AgentChildWorkEvidence) =>
        edge.type === 'live'
          ? `working ${edge.child.description}`
          : edge.type === 'ended'
            ? `${edge.outcome} ${edge.lastMessage ?? ''}`.trim()
            : edge.type
      )
  return { lane, task, states }
}

const input = {
  subagent_type: 'explorer',
  description: 'Ping explorer subagent',
  prompt: `Reply PONG.\n${'context '.repeat(4096)}`
}

describe('Droid Task subagents', () => {
  it('keeps a backgrounded Task working past its turn until its result arrives', () => {
    const { lane, task, states } = droidSession()
    lane.openPrompt('send-1', 1)
    task({ sessionUpdate: 'tool_call', title: 'Task', status: 'pending', rawInput: input }, 2)
    expect(states()).toEqual([])
    task({ _meta: { subagent_session_info: { session_id: 'child', message_start_index: 0 } } }, 3)
    task({ status: 'in_progress', rawOutput: { text: 'Running in background' } }, 4)
    task({ status: 'completed', content: [] }, 5)
    lane.promptResult('send-1', { stopReason: 'end_turn' }, 6)
    task({ status: 'completed', rawOutput: { text: 'PONG' } }, 7)
    expect(states()).toEqual([
      'working Ping explorer subagent',
      'working Ping explorer subagent',
      'succeeded PONG'
    ])
  })

  it('ends a Task the user stopped as cancelled', () => {
    const { lane, task, states } = droidSession()
    lane.openPrompt('send-1', 1)
    task({ sessionUpdate: 'tool_call', title: 'Task', status: 'pending', rawInput: input }, 2)
    task({ _meta: { subagent_session_info: { session_id: 'child', message_start_index: 0 } } }, 3)
    task({ status: 'failed', rawOutput: { text: 'Tool execution cancelled by user' } }, 4)
    lane.promptResult('send-1', { stopReason: 'cancelled' }, 5, true)
    expect(states()).toEqual(['working Ping explorer subagent', 'cancelled'])
  })
})
