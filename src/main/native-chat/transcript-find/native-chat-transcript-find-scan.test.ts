import { expect, it } from 'vitest'
import { selectNativeChatFindMatch } from '../../../shared/native-chat/find/native-chat-session-find'
import { decodeClaudeChatTranscriptLine } from '../transcript-decoding/transcript-line-decoders-claude'
import {
  countNativeChatFindSources,
  NativeChatTranscriptFindScan
} from './native-chat-transcript-find-scan'

function line(record: object): string {
  return JSON.stringify({ timestamp: '2026-11-20T00:00:00.000Z', ...record })
}

it('counts the words a chat draws, not tool output or link targets', () => {
  const scan = new NativeChatTranscriptFindScan('/chats/s.jsonl', decodeClaudeChatTranscriptLine)
  scan.push(
    Buffer.from(
      [
        line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Deploy please' } }),
        line({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'See [the deploy notes](https://x.test/deploy) first.' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'deploy --dry' } }
            ]
          }
        }),
        line({
          type: 'user',
          uuid: 'r1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'deploy ok' }]
          }
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'DEPLOY done, deploy.' }] }
        })
      ].join('\n')
    )
  )
  expect(countNativeChatFindSources(scan.end(), 'deploy')).toEqual([
    { entryId: 'u1', count: 1 },
    { entryId: 'a1', count: 1 },
    { entryId: 'a2', count: 2 }
  ])
})

it('selects from a start message and wraps when stepping past the ends', () => {
  const documents = [
    { entryId: 'a', count: 2 },
    { entryId: 'b', count: 0 },
    { entryId: 'c', count: 1 }
  ]
  expect(selectNativeChatFindMatch(documents, { start: { entryId: 'b', occurrence: 0 } })).toEqual({
    totalMatches: 3,
    activeIndex: 2,
    navigation: [
      { entryId: 'a', count: 2, startIndex: 0 },
      { entryId: 'c', count: 1, startIndex: 2 }
    ],
    match: { entryId: 'c', occurrence: 0 }
  })
  expect(
    selectNativeChatFindMatch(documents, { start: { entryId: 'c', occurrence: 0 }, offset: 1 })
      .match
  ).toEqual({ entryId: 'a', occurrence: 0 })
  expect(
    selectNativeChatFindMatch(documents, { start: { entryId: 'a', occurrence: 0 }, offset: -1 })
      .match
  ).toEqual({ entryId: 'c', occurrence: 0 })
})
