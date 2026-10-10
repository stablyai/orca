import { describe, expect, it } from 'vitest'
import {
  forwardCursorSdkDelta,
  forwardCursorSdkMessage,
  INITIAL_CURSOR_RUN_FORWARD_STATE,
  type CursorRunForwardState
} from './cursor-sdk-run-events'

function texts(events: { type: string; text?: string }[]): string[] {
  return events.flatMap((event) => (event.type === 'text' && event.text ? [event.text] : []))
}

describe('Cursor SDK run forwarding', () => {
  it('keeps token deltas and does not append the same assistant snapshot', () => {
    let state: CursorRunForwardState = INITIAL_CURSOR_RUN_FORWARD_STATE
    const first = forwardCursorSdkDelta(state, { type: 'text-delta', text: 'pon' })
    state = first.state
    const second = forwardCursorSdkDelta(state, { type: 'text-delta', text: 'g' })
    state = second.state
    const snapshot = forwardCursorSdkMessage(state, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'pong' }] }
    })
    expect([...texts(first.events), ...texts(second.events), ...texts(snapshot.events)]).toEqual([
      'pon',
      'g'
    ])
  })

  it('emits an assistant snapshot when no deltas arrived, and only the unseen suffix after', () => {
    const snapshot = forwardCursorSdkMessage(INITIAL_CURSOR_RUN_FORWARD_STATE, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'pong' }] }
    })
    expect(texts(snapshot.events)).toEqual(['pong'])
    const longer = forwardCursorSdkMessage(
      { ...INITIAL_CURSOR_RUN_FORWARD_STATE, pendingText: 'pon' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } }
    )
    expect(texts(longer.events)).toEqual(['g'])
  })

  it('drops a snapshot that diverges from deltas already shown', () => {
    const forwarded = forwardCursorSdkMessage(
      { ...INITIAL_CURSOR_RUN_FORWARD_STATE, pendingText: 'pong' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'other' }] } }
    )
    expect(forwarded.events).toEqual([])
    expect(forwarded.state.pendingText).toBe('pong')
  })

  it('maps a tool call and a task milestone once', () => {
    const tool = forwardCursorSdkMessage(INITIAL_CURSOR_RUN_FORWARD_STATE, {
      type: 'tool_call',
      call_id: 'call-1',
      name: 'shell',
      status: 'completed',
      result: 'ok'
    })
    expect(tool.events).toEqual([
      { type: 'tool', callId: 'call-1', name: 'shell', status: 'completed', result: 'ok' }
    ])
    const task = forwardCursorSdkMessage(INITIAL_CURSOR_RUN_FORWARD_STATE, {
      type: 'task',
      text: 'Reading the file'
    })
    expect(task.events).toEqual([{ type: 'task', text: 'Reading the file' }])
    expect(
      forwardCursorSdkMessage(task.state, { type: 'task', text: 'Reading the file' }).events
    ).toEqual([])
  })
})
