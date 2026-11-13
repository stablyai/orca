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
