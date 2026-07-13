import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from './chat-import-schema'
import { listIngestedExternalIds, upsertWebConversation } from './chat-import-store'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-chat-import-'))
  dirs.push(dir)
  const db = new SyncDatabase(join(dir, 'chats.db'))
  initChatImportSchema(db)
  return db
}

describe('upsertWebConversation', () => {
  it('inserts a conversation and its messages, returning the composite id', () => {
    const db = tempDb()
    const id = upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'abc',
        title: 'Hello',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:05:00.000Z',
        messages: [
          { role: 'USER', idx: 0, text: 'hi', createdAt: null },
          { role: 'AI', idx: 1, text: 'hello!', createdAt: null }
        ]
      },
      '2026-07-13T00:00:00.000Z'
    )
    expect(id).toBe('CHATGPT/abc')
    const conv = db.prepare('SELECT title, source FROM conversations WHERE id = ?').get(id)
    expect(conv).toMatchObject({ title: 'Hello', source: 'CHATGPT' })
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(id)
    expect(count).toMatchObject({ n: 2 })
    db.close()
  })

  it('replaces messages on re-upsert (idempotent)', () => {
    const db = tempDb()
    const conv = {
      source: 'CLAUDE' as const,
      externalId: 'x',
      title: 't',
      createdAt: null,
      updatedAt: null,
      messages: [{ role: 'USER' as const, idx: 0, text: 'one', createdAt: null }]
    }
    upsertWebConversation(db, conv, '2026-07-13T00:00:00.000Z')
    upsertWebConversation(
      db,
      { ...conv, messages: [{ role: 'USER', idx: 0, text: 'two', createdAt: null }] },
      '2026-07-13T00:01:00.000Z'
    )
    const rows = db.prepare('SELECT text FROM messages WHERE conv_id = ?').all('CLAUDE/x')
    expect(rows).toEqual([{ text: 'two' }])
    db.close()
  })
})

describe('listIngestedExternalIds', () => {
  it('lists ingested external ids for one source only', () => {
    const db = tempDb()
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'c1',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-05T00:00:00.000Z'
    )
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'c2',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-05T00:00:00.000Z'
    )
    upsertWebConversation(
      db,
      {
        source: 'CLAUDE',
        externalId: 'x1',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-05T00:00:00.000Z'
    )
    expect(listIngestedExternalIds(db, 'CHATGPT').sort()).toEqual(['c1', 'c2'])
    expect(listIngestedExternalIds(db, 'GEMINI')).toEqual([])
    db.close()
  })
})
