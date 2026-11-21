import { describe, expect, it } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import { readReplyNotes } from './bot-reply-notes'

describe('readReplyNotes', () => {
  it('reads each --note, whose text may hold colons', () => {
    const flags = new Map([
      ['note', ['src/b.ts:12:Use a Map: faster.', 'c.ts:3:Typo'].join(REPEATED_FLAG_SEPARATOR)]
    ])
    expect(readReplyNotes(flags)).toEqual({
      comments: [
        { path: 'src/b.ts', line: 12, body: 'Use a Map: faster.' },
        { path: 'c.ts', line: 3, body: 'Typo' }
      ]
    })
  })

  it.each([
    ['a note without a line', new Map([['note', 'a.ts:Typo']]), 'must look like path:line:text'],
    ['line 0', new Map([['note', 'a.ts:0:Typo']]), 'comments.0.line'],
    [
      'more than 30 notes',
      new Map([
        [
          'note',
          Array.from({ length: 31 }, (_, i) => `a.ts:${i + 1}:x`).join(REPEATED_FLAG_SEPARATOR)
        ]
      ]),
      'comments'
    ]
  ])('refuses %s', (_, flags, says) => {
    expect(() => readReplyNotes(flags)).toThrow(says)
  })
})
