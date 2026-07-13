import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation } from '../chat-import/chat-import-store'
import { scanAiVaultSessions } from './session-scanner'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

describe('scanAiVaultSessions web chat', () => {
  it('surfaces web conversations as read-only sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-int-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const db = new SyncDatabase(dbPath)
    initChatImportSchema(db)
    upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'c1',
        title: 'Web title',
        createdAt: null,
        updatedAt: '2026-07-05T00:00:00.000Z',
        messages: [
          { role: 'USER', idx: 0, text: 'q', createdAt: null },
          { role: 'AI', idx: 1, text: 'a', createdAt: null }
        ]
      },
      'now'
    )
    db.close()

    const result = await scanAiVaultSessions({ platform: 'darwin', webchatDbPath: dbPath })
    const web = result.sessions.filter((s) => s.agent === 'chatgpt')
    expect(web).toHaveLength(1)
    expect(web[0]).toMatchObject({
      title: 'Web title',
      readOnly: true,
      resumeCommand: '',
      cwd: null,
      messageCount: 2
    })
  })
})
