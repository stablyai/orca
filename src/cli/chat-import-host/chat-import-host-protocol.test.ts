import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatImportDbForWrite } from '../../main/chat-import/chat-import-db-open'
import { listIngestedExternalIds } from '../../main/chat-import/chat-import-store'
import { processChatImportHostMessage } from './chat-import-host-protocol'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-proto-'))
  dirs.push(dir)
  return openChatImportDbForWrite(join(dir, 'chats.db'))
}

describe('processChatImportHostMessage', () => {
  it('INGEST stores the conversation and returns its id', () => {
    const db = tempDb()
    const conv = {
      source: 'CHATGPT',
      externalId: 'c1',
      title: 'T',
      createdAt: null,
      updatedAt: null,
      messages: [{ role: 'USER', idx: 0, text: 'hi', createdAt: null }]
    }
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'INGEST', conv }), 'now')
    expect(res).toEqual({ type: 'INGEST', ok: true, id: 'CHATGPT/c1' })
    expect(listIngestedExternalIds(db, 'CHATGPT')).toEqual(['c1'])
  })

  it.each([
    [
      'duplicate idx',
      [
        { role: 'USER', idx: 0 },
        { role: 'AI', idx: 0 }
      ]
    ],
    ['non-integer idx', [{ role: 'USER', idx: 1.5 }]]
  ])('INGEST rejects a conversation with %s before it reaches SQLite', (_label, messages) => {
    const db = tempDb()
    const conv = {
      source: 'CHATGPT',
      externalId: 'bad',
      title: 'T',
      createdAt: null,
      updatedAt: null,
      messages
    }
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'INGEST', conv }), 'now')
    expect(res).toEqual({ type: 'ERROR', error: 'bad conversation' })
    expect(listIngestedExternalIds(db, 'CHATGPT')).toEqual([])
  })

  it('INGESTED_IDS returns stored ids for the source', () => {
    const db = tempDb()
    processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'INGEST',
        conv: {
          source: 'CLAUDE',
          externalId: 'a',
          title: null,
          createdAt: null,
          updatedAt: null,
          messages: []
        }
      }),
      'now'
    )
    const res = processChatImportHostMessage(
      db,
      JSON.stringify({ type: 'INGESTED_IDS', source: 'CLAUDE' }),
      'now'
    )
    expect(res).toEqual({ type: 'INGESTED_IDS', externalIds: ['a'] })
  })

  it('malformed JSON returns an ERROR, not a throw', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(db, '{ not json', 'now')
    expect(res.type).toBe('ERROR')
  })

  it('unknown type returns an ERROR', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'NOPE' }), 'now')
    expect(res.type).toBe('ERROR')
  })

  it('INGEST with a bad source returns an ERROR', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'INGEST',
        conv: { source: 'FACEBOOK', externalId: 'x', messages: [] }
      }),
      'now'
    )
    expect(res.type).toBe('ERROR')
  })

  it('echoes the request _id back on the response', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(
      db,
      JSON.stringify({ type: 'INGESTED_IDS', source: 'CHATGPT', _id: 42 }),
      'now'
    )
    expect(res).toMatchObject({ type: 'INGESTED_IDS', externalIds: [], _id: 42 })
  })

  it('responds to PING with PONG (echoing _id)', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'PING', _id: 7 }), 'now')
    expect(res).toEqual({ type: 'PONG', _id: 7 })
  })

  it('omits _id when the request has none', () => {
    const db = tempDb()
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'PING' }), 'now')
    expect(res).toEqual({ type: 'PONG' })
  })
})
