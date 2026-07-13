import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatImportDbForWrite } from './chat-import-db-open'
import { upsertWebConversation } from './chat-import-store'
import { parseWebChatSqliteSession } from '../ai-vault/session-scanner-webchat-sqlite'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

describe('openChatImportDbForWrite', () => {
  it('creates missing dirs, enables WAL, and initializes schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-wal-'))
    dirs.push(dir)
    const dbPath = join(dir, 'nested', 'chats.db')
    const db = openChatImportDbForWrite(dbPath)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'c1',
        title: 'WAL title',
        createdAt: null,
        updatedAt: '2026-07-05T00:00:00.000Z',
        messages: [{ role: 'USER', idx: 0, text: 'q', createdAt: null }]
      },
      '2026-07-05T00:00:00.000Z'
    )
    db.close()

    // The readonly scanner must be able to read a WAL-mode DB.
    const session = parseWebChatSqliteSession({
      dbPath,
      sessionId: 'c1',
      source: 'CHATGPT',
      platform: 'darwin'
    })
    expect(session?.title).toBe('WAL title')
    expect(session?.readOnly).toBe(true)
  })
})
