import { expect, it } from 'vitest'
import '../../sqlite/sync-database'
import './session-search-write-buffer'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession
} from './session-search-index-test-fixture'

it.each([1, 1_000_000])(
  'persists truncation through search writes with a %i-character buffer',
  async (commitChars) => {
    const index = await openSessionSearchIndexFile('ss-truncation-staging')
    const writer = new SessionSearchIndexWriter(index.db, commitChars)
    const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)
    if (!write) {
      throw new Error('Expected write')
    }
    try {
      write.add({
        role: 'user',
        text: 'reader prefix '.repeat(1000),
        timestamp: null,
        textTruncated: true
      })
      write.add({ role: 'assistant', text: 'complete reply', timestamp: null })
      write.add({ role: 'tool', text: 'output '.repeat(1000), timestamp: null })
      expect(
        write.commit({ session: syntheticSession(), byteOffset: 100, incomplete: false })
      ).toBe(true)
      expect(
        index.db.prepare('SELECT role, text_truncated FROM messages ORDER BY id').all()
      ).toEqual([
        { role: 'user', text_truncated: 1 },
        { role: 'user', text_truncated: 1 },
        { role: 'assistant', text_truncated: 0 }
      ])
    } finally {
      write.discard()
      writer.close()
      await index.close()
    }
  }
)
