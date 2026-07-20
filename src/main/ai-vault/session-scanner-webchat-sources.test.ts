import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation } from '../chat-import/chat-import-store'
import { listWebChatCandidates } from './session-scanner-webchat-sources'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

describe('listWebChatCandidates', () => {
  it('lists one candidate per web conversation, agent by source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-src-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const db = new SyncDatabase(dbPath)
    initChatImportSchema(db)
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'a',
        title: 't',
        createdAt: null,
        updatedAt: '2026-07-02T00:00:00.000Z',
        messages: []
      },
      'now'
    )
    upsertWebConversation(
      db,
      {
        source: 'GEMINI',
        externalId: 'b',
        title: 't2',
        createdAt: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
        messages: []
      },
      'now'
    )
    db.close()

    const cands = listWebChatCandidates({ dbPath, issues: [] })
    expect(cands.map((c) => c.agent).sort()).toEqual(['chatgpt', 'gemini-web'])
    // 최신 updated_at 우선 정렬
    expect(cands[0]?.agent).toBe('chatgpt')
    expect(cands[0]?.file.path).toBe(`${dbPath}#CHATGPT/a`)
    expect(cands.every((c) => c.codexHome === null)).toBe(true)
  })

  it('returns empty when the db is missing', () => {
    expect(listWebChatCandidates({ dbPath: '/no/such/chats.db', issues: [] })).toEqual([])
  })

  it('falls back to synced_at for mtimeMs when updated_at and created_at are both null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-src-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const db = new SyncDatabase(dbPath)
    initChatImportSchema(db)
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'c',
        title: 't3',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-03T00:00:00.000Z'
    )
    db.close()

    const cands = listWebChatCandidates({ dbPath, issues: [] })
    expect(cands).toHaveLength(1)
    expect(cands[0]?.file.mtimeMs).toBe(Date.parse('2026-07-03T00:00:00.000Z'))
  })
})
