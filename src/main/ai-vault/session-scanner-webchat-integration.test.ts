import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation } from '../chat-import/chat-import-store'
import {
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions
} from '../../shared/ai-vault-session-filters'
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

  it('applies webChatCwdByAgent to web chat session cwd', async () => {
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

    const result = await scanAiVaultSessions({
      platform: 'darwin',
      webchatDbPath: dbPath,
      webChatCwdByAgent: { chatgpt: '/x/ChatGPT' }
    })
    const web = result.sessions.find((s) => s.agent === 'chatgpt')
    expect(web?.cwd).toBe('/x/ChatGPT')
  })

  it('leaves web chat session cwd null when webChatCwdByAgent is not provided', async () => {
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
    const web = result.sessions.find((s) => s.agent === 'chatgpt')
    expect(web?.cwd).toBeNull()
  })

  it('groups a scanned web chat session by its resolved cwd, not Unknown location, and excludes it from the workspace scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-webchat-int-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const db = new SyncDatabase(dbPath)
    initChatImportSchema(db)
    upsertWebConversation(
      db,
      {
        source: 'GEMINI',
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

    const result = await scanAiVaultSessions({
      platform: 'darwin',
      webchatDbPath: dbPath,
      webChatCwdByAgent: { 'gemini-web': '/w/Gemini' }
    })
    const web = result.sessions.find((s) => s.agent === 'gemini-web')
    expect(web?.cwd).toBe('/w/Gemini')

    // Project mode with no sessionProjectById entry for this session falls
    // back to folder grouping — the connection that must not degrade to
    // "Unknown location" once a web chat cwd is resolved.
    const groups = groupAiVaultSessions(web ? [web] : [], 'project')
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe(folderLabel('/w/Gemini'))
    expect(groups[0].label).not.toBe('Unknown location')

    const workspaceScoped = filterAiVaultSessions(web ? [web] : [], {
      query: '',
      agents: ['gemini-web'],
      scope: 'workspace',
      sort: 'updated',
      activeWorktreePaths: ['/w'],
      hideEmptySessions: false
    })
    expect(workspaceScoped).toHaveLength(0)
  })
})
