import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createClaudeReadingBarrier } from '../sdk-transport/claude-reading-barrier'
import { createClaudeForkedCommandLiveFrames } from './claude-forked-command-live-frames'

const started = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'fork-1',
  task_type: 'local_agent',
  is_backgrounded: false,
  spawn_depth: 1,
  description: '/code-review'
}

const call = (id: string) => ({ tool_use_id: id, tool_name: 'Bash', tool_input: {} })

function open() {
  const emitted: Record<string, unknown>[] = []
  const reading = createClaudeReadingBarrier(() => false)
  const live = createClaudeForkedCommandLiveFrames((message) => emitted.push(message), reading)
  const fire = async (input: Record<string, unknown>) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the callback reads only the fields each case sets.
    live.hooks.PreToolUse?.[0]?.hooks[0]?.(input as unknown as HookInput, undefined, {
      signal: new AbortController().signal
    })
  return { emitted, reading, live, fire }
}

describe('forked command live frames', () => {
  it('hands nothing over while reading is paused, even for a fork not read yet', async () => {
    const { emitted, reading, live, fire } = open()
    reading.pauseReading()
    await fire({ hook_event_name: 'PreToolUse', agent_id: 'fork-1', ...call('a') })
    await fire({
      hook_event_name: 'SubagentStop',
      agent_id: 'fork-1',
      last_assistant_message: 'report'
    })
    expect(emitted).toEqual([])

    reading.resumeReading()
    live.observe(started)
    await Promise.resolve()
    expect(emitted).toMatchObject([
      { message: { content: [{ type: 'tool_use', id: 'a' }] } },
      { message: { content: [{ type: 'text', text: 'report' }] } }
    ])

    reading.pauseReading()
    await fire({ hook_event_name: 'PreToolUse', agent_id: 'fork-1', ...call('b') })
    expect(emitted).toHaveLength(2)
    reading.resumeReading()
    await Promise.resolve()
    expect(emitted).toHaveLength(3)
  })

  it('settles each call as it ends, then names it again with its output', async () => {
    const { emitted, live, fire } = open()
    live.observe(started)

    await fire({ hook_event_name: 'PreToolUse', agent_id: 'other', ...call('x') })
    await fire({
      hook_event_name: 'PostToolUse',
      agent_id: 'fork-1',
      ...call('ran'),
      tool_response: { stdout: 'out', stderr: 'warn' }
    })
    expect(emitted).toMatchObject([
      {
        parent_tool_use_id: 'forked-command-code-review',
        agent_id: 'fork-1',
        message: { content: [{ tool_use_id: 'ran', content: 'out\nwarn', is_error: false }] }
      }
    ])

    await fire({
      hook_event_name: 'PostToolBatch',
      agent_id: 'fork-1',
      tool_calls: [
        { ...call('ran'), tool_response: 'ok' },
        { ...call('denied'), tool_response: 'no' }
      ]
    })
    expect(emitted.slice(1)).toMatchObject([
      { message: { content: [{ type: 'tool_use', id: 'ran' }, { id: 'denied' }] } },
      {
        message: {
          content: [
            { tool_use_id: 'ran', content: 'ok', is_error: false },
            { tool_use_id: 'denied', is_error: true }
          ]
        }
      }
    ])
  })
})
