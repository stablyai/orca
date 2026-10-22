import { expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchWriteBuffer } from './session-search-write-buffer'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession
} from './session-search-index-test-fixture'

it('keeps exact text, timestamps, and order across spills and closes its temporary database', () => {
  const close = vi.spyOn(SyncDatabase.prototype, 'close')
  const buffer = new SessionSearchWriteBuffer(1)
  const rows = [
    { role: 'user' as const, text: '😀\u0000\nfirst', timestamp: '2026-10-19T00:00:00.000Z' },
    { role: 'tool' as const, text: '工具\r\nsecond', timestamp: null },
    { role: 'assistant' as const, text: 'last', timestamp: null }
  ]
  try {
    buffer.add(rows[0])
    buffer.spill()
    buffer.add(rows[1])
    buffer.spill()
    buffer.add(rows[2])
    expect([...buffer.rows()]).toEqual(rows)
    buffer.clear()
    buffer.clear()
    expect(close).toHaveBeenCalledTimes(1)
    expect([...buffer.rows()]).toEqual([])
    expect(buffer.hasSpilled).toBe(false)
  } finally {
    buffer.clear()
    close.mockRestore()
  }
})

it.each(['discard', 'close', 'removed', 'rollback'] as const)(
  'releases anonymous staging on %s without publishing rows',
  async (end) => {
    const index = await openSessionSearchIndexFile('ss-staging-lifetime')
    const writer = new SessionSearchIndexWriter(index.db, 1)
    const close = vi.spyOn(SyncDatabase.prototype, 'close')
    const write = writer.beginWrite(syntheticCandidate(), 'replace', 0)
    if (!write) {
      throw new Error('Expected write')
    }
    try {
      write.add({ role: 'user', text: 'private message', timestamp: null })
      if (end === 'discard') {
        write.discard()
      }
      if (end === 'close') {
        writer.close()
      }
      if (end === 'removed') {
        writer.removeFile(syntheticCandidate().file.path)
        expect(
          write.commit({ session: syntheticSession(), byteOffset: 10, incomplete: false })
        ).toBe(false)
      }
      if (end === 'rollback') {
        index.db.exec(
          `CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test write failure'); END`
        )
        expect(() =>
          write.commit({ session: syntheticSession(), byteOffset: 10, incomplete: false })
        ).toThrow('test write failure')
      }
      expect(close).toHaveBeenCalledTimes(1)
      expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(0)
      expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(0)
    } finally {
      write.discard()
      writer.close()
      close.mockRestore()
      await index.close()
    }
  }
)
