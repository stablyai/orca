import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from './chat-import-schema'
import {
  listIngestedExternalIds,
  listMessageAttachments,
  upsertWebConversation
} from './chat-import-store'

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

describe('upsertWebConversation attachments', () => {
  it('round-trips message attachments via listMessageAttachments', () => {
    const db = tempDb()
    const id = upsertWebConversation(
      db,
      {
        source: 'CHATGPT',
        externalId: 'att1',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: [
          {
            role: 'USER',
            idx: 0,
            text: 'here is a photo',
            createdAt: null,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                fileName: 'photo.png',
                size: 1234,
                width: 100,
                height: 200,
                hash: 'a'.repeat(64)
              },
              {
                kind: 'file',
                mimeType: 'application/pdf',
                fileName: 'doc.pdf',
                size: 5678,
                width: null,
                height: null,
                hash: 'b'.repeat(64)
              }
            ]
          }
        ]
      },
      '2026-07-13T00:00:00.000Z'
    )
    expect(listMessageAttachments(db, id, 0)).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'photo.png',
        size: 1234,
        width: 100,
        height: 200,
        hash: 'a'.repeat(64)
      },
      {
        kind: 'file',
        mimeType: 'application/pdf',
        fileName: 'doc.pdf',
        size: 5678,
        width: null,
        height: null,
        hash: 'b'.repeat(64)
      }
    ])
    db.close()
  })

  it('skips attachments with an empty hash', () => {
    const db = tempDb()
    const id = upsertWebConversation(
      db,
      {
        source: 'CLAUDE',
        externalId: 'att2',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: [
          {
            role: 'USER',
            idx: 0,
            text: 'x',
            createdAt: null,
            attachments: [
              {
                kind: 'file',
                mimeType: 'text/plain',
                fileName: 'a.txt',
                size: 1,
                width: null,
                height: null,
                hash: ''
              }
            ]
          }
        ]
      },
      '2026-07-13T00:00:00.000Z'
    )
    expect(listMessageAttachments(db, id, 0)).toEqual([])
    db.close()
  })

  it('replaces attachments on re-upsert (idempotent)', () => {
    const db = tempDb()
    const conv = {
      source: 'GEMINI' as const,
      externalId: 'att3',
      title: 't',
      createdAt: null,
      updatedAt: null,
      messages: [
        {
          role: 'USER' as const,
          idx: 0,
          text: 'x',
          createdAt: null,
          attachments: [
            {
              kind: 'image' as const,
              mimeType: 'image/png',
              fileName: 'one.png',
              size: 1,
              width: 1,
              height: 1,
              hash: '1'.repeat(64)
            }
          ]
        }
      ]
    }
    const id = upsertWebConversation(db, conv, '2026-07-13T00:00:00.000Z')
    upsertWebConversation(
      db,
      {
        ...conv,
        messages: [
          {
            role: 'USER',
            idx: 0,
            text: 'x',
            createdAt: null,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                fileName: 'two.png',
                size: 2,
                width: 2,
                height: 2,
                hash: '2'.repeat(64)
              }
            ]
          }
        ]
      },
      '2026-07-13T00:01:00.000Z'
    )
    expect(listMessageAttachments(db, id, 0)).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'two.png',
        size: 2,
        width: 2,
        height: 2,
        hash: '2'.repeat(64)
      }
    ])
    db.close()
  })
})

describe('initChatImportSchema', () => {
  it('sets user_version to 2', () => {
    const db = tempDb()
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    db.close()
  })
})
