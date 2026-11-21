import { expect, it, vi } from 'vitest'
import * as findText from '../../../shared/native-chat/find/native-chat-find-text'
import { decodeClaudeChatTranscriptLine } from '../transcript-decoding/transcript-line-decoders-claude'
import {
  countNativeChatFindSources,
  NativeChatTranscriptFindScan
} from './native-chat-transcript-find-scan'

// Perf contract (STA-15961): whole-chat find decodes each transcript record once and parses
// markdown only for the messages that can hold the query, so a search grows with the chat's
// length, never with its length times its parse cost.

function transcript(turns: number): Buffer {
  const lines: string[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${turn}`,
        timestamp: '2026-11-20T00:00:00.000Z',
        message: { role: 'user', content: `Question ${turn} about the queue` }
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `a${turn}`,
        timestamp: '2026-11-20T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: turn === 7 ? 'The **retry budget** is 3.' : `Answer ${turn}.` }
          ]
        }
      })
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`)
}

function search(turns: number): { decoded: number; parsed: number; matches: number } {
  const decode = vi.fn(decodeClaudeChatTranscriptLine)
  const parse = vi.spyOn(findText, 'nativeChatFindSegments')
  try {
    const scan = new NativeChatTranscriptFindScan('/chats/session.jsonl', decode)
    const bytes = transcript(turns)
    // Fed in uneven pieces, as file reads arrive.
    for (let at = 0; at < bytes.length; at += 4093) {
      scan.push(bytes.subarray(at, at + 4093))
    }
    const documents = countNativeChatFindSources(scan.end(), 'retry budget')
    return {
      decoded: decode.mock.calls.length,
      parsed: parse.mock.calls.length,
      matches: documents.reduce((sum, document) => sum + document.count, 0)
    }
  } finally {
    parse.mockRestore()
  }
}

it('decodes each record once and parses only messages that can match, at N and 10N', () => {
  expect(search(100)).toEqual({ decoded: 200, parsed: 1, matches: 1 })
  expect(search(1000)).toEqual({ decoded: 2000, parsed: 1, matches: 1 })
})
