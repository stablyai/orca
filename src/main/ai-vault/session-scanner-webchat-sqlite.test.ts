import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation } from '../chat-import/chat-import-store'
import { parseWebChatSqliteSession } from './session-scanner-webchat-sqlite'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-'))
  dirs.push(dir)
  const path = join(dir, 'chats.db')
  const db = new SyncDatabase(path)
  initChatImportSchema(db)
  upsertWebConversation(
    db,
    {
      source: 'CHATGPT',
      externalId: 'conv1',
      title: 'My web chat',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:10:00.000Z',
      messages: [
        { role: 'USER', idx: 0, text: 'hello', createdAt: null },
        { role: 'AI', idx: 1, text: 'hi there', createdAt: null }
      ]
    },
    '2026-07-13T00:00:00.000Z'
  )
  db.close()
  return path
}

describe('parseWebChatSqliteSession', () => {
  it('maps a web conversation to a read-only AiVaultSession', () => {
    const path = seed()
    const s = parseWebChatSqliteSession({
      dbPath: path,
      sessionId: 'conv1',
      source: 'CHATGPT',
      platform: 'darwin'
    })
    expect(s).not.toBeNull()
    expect(s?.agent).toBe('chatgpt')
    expect(s?.readOnly).toBe(true)
    expect(s?.title).toBe('My web chat')
    expect(s?.resumeCommand).toBe('')
    expect(s?.cwd).toBeNull()
    expect(s?.messageCount).toBe(2)
    expect(s?.previewMessages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(s?.updatedAt).toBe('2026-07-01T00:10:00.000Z')
  })

  it('returns null when the conversation id is absent', () => {
    const path = seed()
    expect(
      parseWebChatSqliteSession({
        dbPath: path,
        sessionId: 'missing',
        source: 'CHATGPT',
        platform: 'darwin'
      })
    ).toBeNull()
  })
})
