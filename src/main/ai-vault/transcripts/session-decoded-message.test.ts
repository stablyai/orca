import { expect, it } from 'vitest'
import { decodeSessionMessage } from './session-decoded-message'

it('decodes thinking text as reasoning in block order and drops redacted placeholders', () => {
  expect(
    decodeSessionMessage(
      'assistant',
      [
        { type: 'thinking', thinking: 'Compare the two results.', signature: 'opaque' },
        { type: 'text', text: 'The result is 42.' },
        { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
        { type: 'thinking', thinking: 'Now merge.' },
        { type: 'text', text: 'Merged.' }
      ],
      null
    ).blocks
  ).toEqual([
    { kind: 'reasoning', text: 'Compare the two results.' },
    { kind: 'text', text: 'The result is 42.' },
    { kind: 'reasoning', text: 'Now merge.' },
    { kind: 'text', text: 'Merged.' }
  ])
})
