import { describe, expect, it } from 'vitest'
import { limitJournalReaderReply } from './journal-sql-reader-reply-limit'

describe('limitJournalReaderReply', () => {
  const MB = 2 ** 20
  const rows = (count: number, text = 'x'.repeat(1024)): object[] =>
    Array.from({ length: count }, (_, index) => ({
      itemId: `item-${index}`,
      kind: 'tool-call',
      text
    }))

  it('turns a decoded whole-chat read into its request failure and passes a bounded page', () => {
    const wholeChat = { type: 'point', id: 7, result: { items: rows(20_000) } }
    const page = { type: 'page', id: 8, items: rows(512) }

    expect(limitJournalReaderReply(wholeChat, 8 * MB)).toMatchObject({
      type: 'failed',
      id: 7,
      error: { message: `journal read reply (point) exceeds ${8 * MB} bytes` }
    })
    expect(limitJournalReaderReply(page, 8 * MB)).toBe(page)
  })

  it('measures rows past the bounded walk instead of trusting the small ones it saw', () => {
    const items = [...rows(2_048, 'x'.repeat(16)), ...rows(400, 'x'.repeat(64 * 1024))]
    expect(
      limitJournalReaderReply({ type: 'point', id: 9, result: { items } }, 8 * MB)
    ).toMatchObject({ type: 'failed', id: 9 })
  })

  it('passes a lone item over the limit, which no page can split', () => {
    const lone = {
      type: 'point',
      id: 11,
      result: {
        kind: 'items-by-kind',
        items: [{ itemId: 'big', text: 'x'.repeat(9 * MB) }],
        nextOrdinal: 4
      }
    }
    expect(limitJournalReaderReply(lone, 8 * MB)).toBe(lone)
  })

  it('never refuses the record set, which every chat needs to open', () => {
    const recordSet = {
      type: 'database',
      id: 10,
      result: { kind: 'records', records: rows(20_000) }
    }
    expect(limitJournalReaderReply(recordSet, 8 * MB)).toBe(recordSet)
  })
})
