import { expect, it, vi } from 'vitest'
import { boundedText, transcriptMessagesFromContent } from './session-transcript-message-content'
import { asRecord } from './session-scanner-record-value'

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
    { role: 'assistant', text: 'x'.repeat(MESSAGE_LIMIT), timestamp: AT },
    { role: 'tool', text: 'Read: after-large-text', timestamp: AT },
    { role: 'tool', text: `header\n${'x'.repeat(MESSAGE_LIMIT - 7)}`, timestamp: AT },
    { role: 'tool', text: 'Bash: pwd', timestamp: AT },
    { role: 'tool', text: 'finished', timestamp: AT }
  ])
  expect(largestJoinedLength).toBeLessThanOrEqual(MESSAGE_LIMIT + 1)
})

function previousToolResultText(content: unknown): string | null {
  if (typeof content === 'string') {
    return boundedText(content)
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  let length = 0
  for (const item of content) {
    const text = typeof item === 'string' ? item : asRecord(item)?.text
    if (typeof text === 'string' && text) {
      parts.push(text)
      length += text.length
      if (length >= MESSAGE_LIMIT) {
        break
      }
    }
  }
  return boundedText(parts.join('\n'))
}

it('matches the previous tool-result collector at newline and surrogate boundaries', () => {
  const cases: unknown[][] = [
    ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800'],
    ['x'.repeat(MESSAGE_LIMIT - 1), '\ud800'],
    [`${'x'.repeat(MESSAGE_LIMIT - 1)}\ud800`, 'later'],
    ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800\udc00', 'later'],
    ['x'.repeat(MESSAGE_LIMIT), '', 'later'],
    ['', '', '\ud800', '\udfff', '\u0000'],
    [' '.repeat(MESSAGE_LIMIT), 'visible beyond the cap'],
    [null, 10, { type: 'image', text: 'still collected' }, { content: 'ignored' }]
  ]
  let seed = 0x6a09e667
  const random = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  const lengths = [0, 1, 12, 4096, MESSAGE_LIMIT - 1, MESSAGE_LIMIT, MESSAGE_LIMIT + 1]
  const atoms = ['a', ' ', '\n', '\ud800', '\udfff', '\ud83d\ude80', '\u0000', '漢']
  for (let sample = 0; sample < 120; sample++) {
    cases.push(
      Array.from({ length: 1 + (random() % 6) }, (_, index) => {
        const length = lengths[random() % lengths.length]
        const atom = atoms[random() % atoms.length]
        const text = atom.repeat(Math.ceil(length / atom.length)).slice(0, length)
        return index % 2 === 0 ? text : { type: 'text', text }
      })
    )
  }
  for (const content of cases) {
    const text = previousToolResultText(content)
    expect(
      transcriptMessagesFromContent(
        'user',
        [
          { type: 'tool_result', content },
          { type: 'tool_use', name: 'Read', input: { path: 'after' } },
          { type: 'tool_result', content: 'finished' }
        ],
        AT
      )
    ).toEqual([
      ...(text ? [{ role: 'tool', text, timestamp: AT }] : []),
      { role: 'tool', text: 'Read: after', timestamp: AT },
      { role: 'tool', text: 'finished', timestamp: AT }
    ])
  }
})

it('matches join-then-bound at newline and raw surrogate boundaries', () => {
  const partsCases = [
    ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800'],
    ['x'.repeat(MESSAGE_LIMIT - 1), '\ud800'],
    [`${'x'.repeat(MESSAGE_LIMIT - 1)}\ud800`, 'later'],
    ['x'.repeat(MESSAGE_LIMIT - 2), '\ud800\udc00', 'later'],
    ['x'.repeat(MESSAGE_LIMIT - 3), '\ud800\udc00', 'later'],
    ['x'.repeat(MESSAGE_LIMIT), '', 'later'],
    ['', '', '\ud800', '\udfff', '\u0000'],
    [' '.repeat(MESSAGE_LIMIT), 'visible beyond the cap']
  ]
  for (const parts of partsCases) {
    const text = boundedText(parts.join('\n'))
    expect(transcriptMessagesFromContent('user', parts, AT)).toEqual(
      text ? [{ role: 'user', text, timestamp: AT }] : []
    )
  }
})

it('matches the previous join-then-bound output across generated block mixtures', () => {
  let seed = 0x6a09e667
  const random = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  const lengths = [0, 1, 12, 4096, MESSAGE_LIMIT - 1, MESSAGE_LIMIT, MESSAGE_LIMIT + 1]
  const atoms = ['a', ' ', '\n', '\ud800', '\udfff', '\ud83d\ude80', '\u0000', '漢']
  const roles = ['user', 'assistant', 'tool', 'system', 'unknown'] as const
  for (let sample = 0; sample < 120; sample++) {
    const parts = Array.from({ length: 2 + (random() % 7) }, () => {
      const length = lengths[random() % lengths.length]
      const atom = atoms[random() % atoms.length]
      return atom.repeat(Math.ceil(length / atom.length)).slice(0, length)
    })
    const role = roles[random() % roles.length]
    const content = parts.map((text, index) => (index % 2 === 0 ? text : { type: 'Text', text }))
    const text = boundedText(parts.filter((part, index) => index % 2 === 0 || part).join('\n'))
    expect(
      transcriptMessagesFromContent(
        role,
        [...content, { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }],
        AT
      )
    ).toEqual([
      ...(text && (role === 'user' || role === 'assistant' || role === 'tool')
        ? [{ role, text, timestamp: AT }]
        : []),
      { role: 'tool', text: 'Bash: pwd', timestamp: AT }
    ])
  }
})
