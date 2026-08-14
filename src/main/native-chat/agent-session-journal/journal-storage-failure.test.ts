import { describe, expect, it } from 'vitest'
import type { JournalRow } from './journal-row-schema'
import { JournalAppendStorage } from './journal-append-storage'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'

const ROW: JournalRow = {
  v: 1,
  kind: 'item',
  epoch: 'epoch-1',
  seq: 2,
  fence: 1,
  ts: 1_000,
  itemId: 'item-1',
  revision: 1,
  body: { kind: 'message', role: 'assistant', blocks: [] }
}

describe('journal storage failure boundary', () => {
  it('poisons the writer after an ambiguous row append failure', async () => {
    const storage = new JournalAppendStorage(
      'session-1',
      '/journal',
      DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      {
        appendRows: async () => {
          throw new Error('fsync failed after append')
        },
        measure: async () => 0
      }
    )
    await storage.open()

    await expect(storage.append(ROW, 1_000)).rejects.toThrow('fsync failed after append')
    expect(storage.isPoisoned).toBe(true)
    await expect(storage.append({ ...ROW, seq: 3 }, 1_001)).rejects.toMatchObject({
      code: 'journal_read_only'
    })
  })

  it('stays poisoned when post-failure footprint measurement also fails', async () => {
    let measurements = 0
    const storage = new JournalAppendStorage(
      'session-1',
      '/journal',
      DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      {
        appendRows: async () => {
          throw new Error('append failed')
        },
        measure: async () => {
          measurements += 1
          if (measurements > 1) {
            throw new Error('footprint unavailable')
          }
          return 0
        }
      }
    )
    await storage.open()

    await expect(storage.append(ROW, 1_000)).rejects.toBeInstanceOf(AggregateError)
    expect(storage.isPoisoned).toBe(true)
  })
})
