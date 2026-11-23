import { expect, it } from 'vitest'
import { PiRpcContextUsage } from './rpc-context-usage'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
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

it('closes completed Pi edit and write calls as file diffs', () => {
  const messages = new PiRpcMessages('g', new PiRpcContextUsage())
  const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -2,1 +2,1 @@\n-a\n+b\n'
  messages.tool({
    type: 'tool_execution_start',
    toolCallId: 'e',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
  })
  expect(
    messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'e',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'Edited' }], details: { diff: '', patch } }
    })[0]
  ).toMatchObject({
    type: 'item.close',
    item: 'tool:e',
    body: { kind: 'diff', path: 'src/a.ts', patch: { head: patch, truncated: false } }
  })

  messages.tool({
    type: 'tool_execution_start',
    toolCallId: 'w',
    toolName: 'write',
    args: { path: 'src/b.ts', content: 'one\ntwo' }
  })
  expect(
    messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'w',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'Wrote' }] }
    })[0]
  ).toMatchObject({
    body: {
      kind: 'diff',
      path: 'src/b.ts',
      patch: {
        head: '--- src/b.ts\n+++ src/b.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n'
      }
    }
  })

  messages.tool({
    type: 'tool_execution_start',
    toolCallId: 'f',
    toolName: 'write',
    args: { path: 'src/c.ts', content: 'x' }
  })
  expect(
    messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'f',
      toolName: 'write',
      isError: true,
      result: { content: [{ type: 'text', text: 'EACCES' }] }
    })[0]
  ).toMatchObject({ body: { kind: 'tool-call', name: 'write', state: 'failed' } })

  const writeClose = (id: string, content: string): ProviderTimelineEvent | undefined => {
    messages.tool({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: 'write',
      args: { path: `src/${id}.ts`, content }
    })
    return messages.tool({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'Wrote' }] }
    })[0]
  }
  expect(writeClose('lines-at-cap', 'a\n'.repeat(16 * 1024))).toMatchObject({
    body: { kind: 'diff', path: 'src/lines-at-cap.ts' }
  })
  expect(writeClose('lines-over-cap', 'a\n'.repeat(16 * 1024 + 1))).toMatchObject({
    body: { kind: 'tool-call', name: 'write', state: 'completed' }
  })
  expect(writeClose('chars-at-cap', 'a'.repeat(64 * 1024))).toMatchObject({
    body: { kind: 'diff', path: 'src/chars-at-cap.ts' }
  })
  expect(writeClose('chars-over-cap', 'a'.repeat(64 * 1024 + 1))).toMatchObject({
    body: { kind: 'tool-call', name: 'write', state: 'completed' }
  })
})

it('keeps the tool row for a Pi edit result without details.patch', () => {
  const messages = new PiRpcMessages('g', new PiRpcContextUsage())
  messages.tool({
    type: 'tool_execution_start',
    toolCallId: 'e',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
  })
  expect(
    messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'e',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'Edited' }] }
    })[0]
  ).toMatchObject({ body: { kind: 'tool-call', name: 'edit', state: 'completed' } })
})
