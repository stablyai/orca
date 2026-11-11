import { expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchWriteBuffer, SessionSearchStagingBudget } from './session-search-write-buffer'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession
} from './session-search-index-test-fixture'

it('keeps text, timestamps, truncation, and order across spills and closes its temporary database', () => {
  const close = vi.spyOn(SyncDatabase.prototype, 'close')
  const buffer = new SessionSearchWriteBuffer(1)
  const rows = [
    {
      role: 'user' as const,
      text: '😀\u0000\nfirst',
      timestamp: '2026-10-19T00:00:00.000Z',
      textTruncated: true as const
    },
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

it('shares resident staging across handles without changing publication readiness or row order', () => {
  const budget = new SessionSearchStagingBudget()
  const buffers = Array.from(
    { length: 4 },
    () => new SessionSearchWriteBuffer(32 * 1024 * 1024, budget)
  )
  const text = '界'.repeat(8000)
  try {
    for (const buffer of buffers) {
      for (let row = 0; row < 200; row++) {
        buffer.add({ role: 'user', text: `${row}:${text}`, timestamp: null })
      }
    }
    expect(budget.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    for (const buffer of buffers) {
      expect(buffer.ready).toBe(false)
      expect([...buffer.rows()].map((row) => row.text)).toEqual(
        Array.from({ length: 200 }, (_, row) => `${row}:${text}`)
      )
    }
  } finally {
    for (const buffer of buffers) {
      buffer.release()
    }
  }
  expect(budget.bytes).toBe(0)
})
