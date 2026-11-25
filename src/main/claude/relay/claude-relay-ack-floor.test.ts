import { describe, expect, it } from 'vitest'
import { claudeRelayAckFloor } from './claude-relay-ack-floor'

const frame = (value: unknown) => JSON.stringify(value)
const stream = (type: string, parent: string | null = null) =>
  frame({ type: 'stream_event', event: { type }, session_id: 's', parent_tool_use_id: parent })
const toolUse = (id: string, parent: string | null = null) =>
  frame({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash' }] },
    session_id: 's',
    parent_tool_use_id: parent
  })
const toolResult = (id: string) =>
  frame({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
    session_id: 's'
  })

// A reattach replays from the floor, so the new app rebuilds each open item on its own row.
describe('Claude relay ack floor', () => {
  it('holds a streamed message until its stop, though each block ends before it', () => {
    const floor = claudeRelayAckFloor()
    floor.observe(1, frame({ type: 'system', subtype: 'init', session_id: 's' }))
    expect(floor.floor()).toBe(null)
    floor.observe(2, stream('message_start'))
    floor.observe(3, stream('content_block_delta'))
    // The CLI sends each block's final frame before the message ends (thinking, then text).
    floor.observe(4, frame({ type: 'assistant', session_id: 's', parent_tool_use_id: null }))
    floor.observe(5, stream('content_block_delta'))
    expect(floor.floor()).toBe(2)
    floor.observe(6, stream('message_stop'))
    expect(floor.floor()).toBe(null)
  })

  it('holds a tool call from its message start until its result', () => {
    const floor = claudeRelayAckFloor()
    floor.observe(1, stream('message_start'))
    floor.observe(2, toolUse('t1'))
    floor.observe(3, stream('message_stop'))
    expect(floor.floor()).toBe(1)
    floor.observe(4, toolResult('t1'))
    expect(floor.floor()).toBe(null)
  })

  it("keeps a background subagent's open call past the turn's end, never replaying that end", () => {
    const floor = claudeRelayAckFloor()
    floor.observe(
      1,
      frame({ type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'agent-1' })
    )
    floor.observe(
      2,
      frame({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'k',
        patch: { is_backgrounded: true }
      })
    )
    floor.observe(3, toolUse('t2', 'agent-1'))
    floor.observe(4, toolResult('agent-1'))
    expect(floor.floor()).toBe(3)
    // The turn's end is saved: a replay starting before it would settle the next turn with it.
    floor.observe(5, frame({ type: 'result', session_id: 's' }))
    expect(floor.floor()).toBe(6)
    expect(floor.tookCut?.()).toBe(false)
    floor.observe(
      6,
      frame({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'k',
        tool_use_id: 'agent-1',
        session_id: 's'
      })
    )
    expect(floor.floor()).toBe(null)
  })

  it("ends a foreground subagent's open calls with its launching call's result", () => {
    const floor = claudeRelayAckFloor()
    floor.observe(1, toolUse('t3', 'agent-2'))
    expect(floor.floor()).toBe(1)
    floor.observe(2, toolResult('agent-2'))
    expect(floor.floor()).toBe(null)
  })

  it("reports a cut once when a turn's end lifts the floor past a streaming subagent message", () => {
    const floor = claudeRelayAckFloor()
    floor.observe(1, stream('message_start', 'agent-1'))
    floor.observe(2, frame({ type: 'result', session_id: 's' }))
    expect(floor.floor()).toBe(3)
    expect(floor.tookCut?.()).toBe(true)
    expect(floor.tookCut?.()).toBe(false)
  })
})
