import { describe, expect, it } from 'vitest'
import { nativeChatRowTurnKeys } from '../../shared/native-chat/transcript/native-chat-turn-grouping'
import {
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from '../../shared/native-chat/transcript/native-chat-turn-fold'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Text rows of a Claude Code 2.1.316 turn whose Stop hook blocked once.
function stopHookTurn(feedback: string): string[] {
  return [
    { type: 'user', uuid: 'prompt', message: { role: 'user', content: 'Say: the sky is blue' } },
    {
      type: 'assistant',
      uuid: 'reply',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The sky is blue.' }] }
    },
    {
      type: 'user',
      uuid: 'feedback',
      isMeta: true,
      message: { role: 'user', content: `Stop hook feedback:\n${feedback}` }
    },
    {
      type: 'assistant',
      uuid: 'continuation',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Evidence: I checked.' }] }
    }
  ].map((record) => JSON.stringify({ timestamp: '2026-11-01T05:33:22.035Z', ...record }))
}

describe('a Claude turn its Stop hook sent back', () => {
  it.each([
    ['a JSON block decision', 'Verify your statement with evidence.'],
    ['an exit-2 hook', '[/tmp/hook.sh]: Verify your statement with evidence.\n']
  ])('keeps the reply and the hook row visible once settled (%s)', (_, feedback) => {
    const messages = stopHookTurn(feedback).flatMap(
      (line) => decodeClaudeTranscriptLine(line, 'fallback') ?? []
    )
    const turnKeys = nativeChatRowTurnKeys(messages)
    const { foldedRows } = nativeChatTurnFold({
      rows: messages.map((message, index) =>
        nativeChatTurnFoldRow(message, turnKeys[index], false)
      ),
      settledTurnKeys: new Set(['prompt']),
      expandedTurnKeys: new Set()
    })
    expect(
      messages.flatMap((message, index) =>
        foldedRows.has(index) ? [] : [[message.role, message.blocks[0]]]
      )
    ).toEqual([
      ['user', { type: 'text', text: 'Say: the sky is blue' }],
      ['assistant', { type: 'text', text: 'The sky is blue.' }],
      [
        'system',
        expect.objectContaining({
          text: 'Stop hook feedback: Verify your statement with evidence.',
          tone: 'warning'
        })
      ],
      ['assistant', { type: 'text', text: 'Evidence: I checked.' }]
    ])
  })
})
