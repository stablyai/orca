import { expect, it } from 'vitest'
import { transcriptMessagesFromContent } from './session-transcript-message-content'

const AT = '2026-05-01T10:00:00.000Z'

it('keeps a plain string turn under the record role', () => {
  expect(transcriptMessagesFromContent('user', 'just words', AT)).toEqual([
    { role: 'user', text: 'just words', timestamp: AT }
  ])
})

it('drops turns whose role a consumer cannot use', () => {
  expect(transcriptMessagesFromContent('system', 'boot', AT)).toEqual([])
  expect(transcriptMessagesFromContent('unknown', 'noise', AT)).toEqual([])
})

it('joins text blocks and appends tool blocks as their own messages', () => {
  expect(
    transcriptMessagesFromContent(
      'assistant',
      [
        { type: 'text', text: 'first' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'ignored' } },
        { type: 'thinking', text: 'second' },
        { type: 'image', source: {} }
      ],
      AT
    )
  ).toEqual([
    { role: 'assistant', text: 'first\nsecond', timestamp: AT },
    { role: 'tool', text: 'Bash: ls -la', timestamp: AT }
  ])
})

it('reads a tool result carried on a user record as a tool message', () => {
  expect(
    transcriptMessagesFromContent(
      'user',
      [{ type: 'tool_result', content: [{ type: 'text', text: 'exit 0' }] }],
      AT
    )
  ).toEqual([{ role: 'tool', text: 'exit 0', timestamp: AT }])
})

it('names a tool call even with no recognisable argument', () => {
  expect(
    transcriptMessagesFromContent('assistant', [{ type: 'tool_use', name: 'Read', input: {} }], AT)
  ).toEqual([{ role: 'tool', text: 'Read', timestamp: AT }])
})

it('emits nothing for blank or absent content', () => {
  expect(transcriptMessagesFromContent('user', '   ', AT)).toEqual([])
  expect(transcriptMessagesFromContent('user', null, AT)).toEqual([])
  expect(transcriptMessagesFromContent('assistant', [{ type: 'tool_use' }], AT)).toEqual([])
})

it('does not apply the list preview cap', () => {
  const long = 'x'.repeat(5000)
  const [message] = transcriptMessagesFromContent('user', [{ type: 'text', text: long }], AT)
  expect(message.text).toHaveLength(5000)
})
