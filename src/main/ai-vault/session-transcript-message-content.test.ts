import { expect, it, vi } from 'vitest'
import {
  transcriptMessageFromText,
  transcriptMessagesFromDecodedMessage,
  transcriptMessagesFromContent
} from './session-transcript-message-content'
import { decodeSessionMessage } from './session-decoded-message'

const AT = '2026-05-01T10:00:00.000Z'
const MESSAGE_LIMIT = 256 * 1024

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

it('accepts the capitalised Text block Codex writes for a completed agent message', () => {
  expect(
    transcriptMessagesFromContent('assistant', [{ type: 'Text', text: 'the reply' }], AT)
  ).toEqual([{ role: 'assistant', text: 'the reply', timestamp: AT }])
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

it.each([
  { tail: [], truncated: false },
  { tail: ['', null, { type: 'image', source: {} }], truncated: false },
  {
    tail: [
      { type: 'image', source: {} },
      { type: 'text', text: 'later' }
    ],
    truncated: true
  }
])(
  'only flags a full tool result when later text is omitted: $truncated',
  ({ tail, truncated }) => {
    const [message] = transcriptMessagesFromContent(
      'user',
      [
        {
          type: 'tool_result',
          content: [{ type: 'text', text: 'x'.repeat(MESSAGE_LIMIT) }, ...tail]
        }
      ],
      AT
    )
    expect(message.text).toBe('x'.repeat(MESSAGE_LIMIT))
    expect(message.textTruncated).toBe(truncated ? true : undefined)
  }
)

it('reports size limits and preserves truncation from an earlier limit', () => {
  expect(
    transcriptMessageFromText('user', 'x'.repeat(MESSAGE_LIMIT), AT)?.textTruncated
  ).toBeUndefined()
  const clipped = transcriptMessageFromText('user', `${'x'.repeat(MESSAGE_LIMIT - 1)}😀`, AT)
  expect(clipped?.text).toBe('x'.repeat(MESSAGE_LIMIT - 1))
  expect(clipped?.textTruncated).toBe(true)
  expect(transcriptMessageFromText('tool', 'short prefix', AT, true)?.textTruncated).toBe(true)
  expect(
    transcriptMessagesFromContent(
      'assistant',
      [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2001) } }],
      AT
    )[0]?.textTruncated
  ).toBe(true)
})

it('reads tool-result parts lazily and can project the same decoded result again', () => {
  const decoded = decodeSessionMessage(
    'user',
    [
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'x'.repeat(MESSAGE_LIMIT) },
          { type: 'text', text: 'omitted text' },
          {
            type: 'text',
            get text() {
              throw new Error('Read beyond the tool-result safety limit')
            }
          }
        ]
      }
    ],
    AT
  )
  for (let read = 0; read < 2; read++) {
    expect(transcriptMessagesFromDecodedMessage(decoded)).toEqual([
      { role: 'tool', text: 'x'.repeat(MESSAGE_LIMIT), timestamp: AT, textTruncated: true }
    ])
  }
})

it('bounds joins for a large multi-block turn and keeps its later tool messages', () => {
  const blockText = 'x'.repeat(1024 * 1024)
  const content = [
    ...Array.from({ length: 72 }, () => ({ type: 'text', text: blockText })),
    { type: 'tool_use', name: 'Read', input: { path: 'after-large-text' } },
    {
      type: 'tool_result',
      content: [
        { type: 'text', text: 'header' },
        { type: 'text', text: blockText.repeat(50) },
        { type: 'text', text: 'ignored after the existing result cap' }
      ]
    },
    { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_result', content: 'finished' }
  ]
  const join = Array.prototype.join
  let largestJoinedLength = 0
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator
  ) {
    let length = Math.max(0, this.length - 1) * (separator ?? ',').length
    for (const value of this) {
      length += typeof value === 'string' ? value.length : 0
    }
    largestJoinedLength = Math.max(largestJoinedLength, length)
    return join.call(this, separator)
  })
  let messages
  try {
    messages = transcriptMessagesFromContent('assistant', content, AT)
  } finally {
    spy.mockRestore()
  }
  expect(messages).toEqual([
    { role: 'assistant', text: 'x'.repeat(MESSAGE_LIMIT), timestamp: AT, textTruncated: true },
    { role: 'tool', text: 'Read: after-large-text', timestamp: AT },
    {
      role: 'tool',
      text: `header\n${'x'.repeat(MESSAGE_LIMIT - 7)}`,
      timestamp: AT,
      textTruncated: true
    },
    { role: 'tool', text: 'Bash: pwd', timestamp: AT },
    { role: 'tool', text: 'finished', timestamp: AT }
  ])
  expect(largestJoinedLength).toBeLessThanOrEqual(MESSAGE_LIMIT + 1)
})

it('bounds joined text at newline and raw surrogate boundaries', () => {
  const cases = [
    {
      parts: ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800'],
      text: `${'x'.repeat(MESSAGE_LIMIT - 2)}\n\ud800`,
      truncated: false
    },
    {
      parts: ['x'.repeat(MESSAGE_LIMIT - 1), '\ud800'],
      text: `${'x'.repeat(MESSAGE_LIMIT - 1)}\n`,
      truncated: true
    },
    {
      parts: [`${'x'.repeat(MESSAGE_LIMIT - 1)}\ud800`, 'later'],
      text: 'x'.repeat(MESSAGE_LIMIT - 1),
      truncated: true
    },
    {
      parts: ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800\udc00', 'later'],
      text: `${'x'.repeat(MESSAGE_LIMIT - 2)}\n`,
      truncated: true
    },
    {
      parts: ['x'.repeat(MESSAGE_LIMIT - 3), '\ud800\udc00', 'later'],
      text: `${'x'.repeat(MESSAGE_LIMIT - 3)}\n\ud800\udc00`,
      truncated: true
    },
    {
      parts: ['x'.repeat(MESSAGE_LIMIT), '', 'later'],
      text: 'x'.repeat(MESSAGE_LIMIT),
      truncated: true
    },
    {
      parts: ['', '', '\ud800', '\udfff', '\u0000'],
      text: '\n\n\ud800\n\udfff\n\u0000',
      truncated: false
    },
    { parts: [' '.repeat(MESSAGE_LIMIT), 'visible beyond the cap'], text: null, truncated: false }
  ]
  for (const { parts, text, truncated } of cases) {
    expect(transcriptMessagesFromContent('user', parts, AT)).toEqual(
      text === null
        ? []
        : [{ role: 'user', text, timestamp: AT, ...(truncated ? { textTruncated: true } : {}) }]
    )
  }
})
