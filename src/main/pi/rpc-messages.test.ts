import { expect, it } from 'vitest'
import { PiRpcContextUsage } from './rpc-context-usage'
import { PiRpcMessages } from './rpc-messages'

it('closes more than 128 concurrent text blocks without dropping early late text', () => {
  const messages = new PiRpcMessages('g', new PiRpcContextUsage())
  messages.message({ type: 'message_start' }, 1)
  for (let index = 0; index < 160; index += 1) {
    expect(
      messages.message(
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta: 'A' }
        },
        2
      )
    ).toEqual([
      {
        type: 'text.delta',
        item: { id: `message:g:1:${index}:assistant` },
        channel: 'assistant',
        text: 'A'
      }
    ])
  }
  expect(
    messages.message(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'B' }
      },
      3
    )
  ).toEqual([
    { type: 'text.delta', item: { id: 'message:g:1:0:assistant' }, channel: 'assistant', text: 'B' }
  ])
  const closed = messages.message(
    { type: 'message_end', message: { role: 'assistant', content: [] } },
    4
  )
  expect(closed).toHaveLength(160)
  expect(closed[0]).toEqual({ type: 'text.close', item: { id: 'message:g:1:0:assistant' } })
})

it('keeps complete tool fields past the former count and aggregate preview limits, then resets them', () => {
  const messages = new PiRpcMessages('g', new PiRpcContextUsage())
  const output = 'x'.repeat(24_000)
  for (let index = 0; index < 160; index += 1) {
    messages.tool({
      type: 'tool_execution_start',
      toolCallId: `call-${index}`,
      toolName: 'read',
      args: { path: 'large.txt' },
      partialResult: { content: [{ type: 'text', text: output }] }
    })
  }
  expect(
    messages.tool({ type: 'tool_execution_end', toolCallId: 'call-0', toolName: 'read' })
  ).toMatchObject([
    {
      type: 'item.close',
      item: 'tool:call-0',
      body: {
        kind: 'tool-call',
        name: 'read',
        input: { path: 'large.txt' },
        state: 'completed',
        output: { head: output, truncated: false }
      }
    }
  ])
  messages.reset()
  expect(
    messages.tool({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' })
  ).toEqual([
    {
      type: 'item.open',
      item: 'tool:call-1',
      body: { kind: 'tool-call', callId: 'call-1', name: 'read', input: null, state: 'running' }
    }
  ])
})
