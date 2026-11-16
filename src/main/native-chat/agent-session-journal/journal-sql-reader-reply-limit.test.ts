import { describe, expect, it } from 'vitest'
import { journalReaderReplyExceedsLimit } from './journal-sql-reader-reply-limit'

describe('journalReaderReplyExceedsLimit', () => {
  const MB = 2 ** 20

  it('refuses a decoded whole-chat read and passes a bounded page', () => {
    const rows = (count: number): object[] =>
      Array.from({ length: count }, (_, index) => ({
        itemId: `item-${index}`,
        kind: 'tool-call',
        text: 'x'.repeat(1024)
      }))
    const wholeChat = { type: 'point', id: 7, result: { items: rows(20_000) } }
    const page = { type: 'page', id: 8, items: rows(512) }

    expect(journalReaderReplyExceedsLimit(wholeChat, 8 * MB)).toBe(true)
    expect(journalReaderReplyExceedsLimit(page, 8 * MB)).toBe(false)
  })
})
