import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChatImportDbForWrite } from '../../main/chat-import/chat-import-db-open'
import {
  listIngestedExternalIds,
  listMessageAttachments
} from '../../main/chat-import/chat-import-store'
import { processChatImportHostMessage } from './chat-import-host-protocol'

function freshBlobCtx(): { uploads: Map<string, Buffer[]>; putBlob: (bytes: Buffer) => string } {
  return { uploads: new Map(), putBlob: vi.fn(() => 'a'.repeat(64)) }
}

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

  it('STORE_BLOB with a single chunk stores the blob and returns its hash', () => {
    const db = tempDb()
    const blobCtx = freshBlobCtx()
    const bytes = Buffer.from('hello world')
    const res = processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'STORE_BLOB',
        uploadId: 'u1',
        seq: 0,
        total: 1,
        data: bytes.toString('base64')
      }),
      'now',
      blobCtx
    )
    expect(res).toMatchObject({ type: 'STORE_BLOB', ok: true, size: bytes.length })
    expect((res as { hash?: string }).hash).toMatch(/^[0-9a-f]{64}$/)
    expect(blobCtx.putBlob).toHaveBeenCalledTimes(1)
    expect(blobCtx.putBlob).toHaveBeenCalledWith(bytes)
    expect(blobCtx.uploads.has('u1')).toBe(false)
  })

  it('STORE_BLOB reassembles multiple chunks before calling putBlob', () => {
    const db = tempDb()
    const blobCtx = freshBlobCtx()
    const part0 = Buffer.from('hello ')
    const part1 = Buffer.from('world')

    const res0 = processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'STORE_BLOB',
        uploadId: 'u2',
        seq: 0,
        total: 2,
        data: part0.toString('base64')
      }),
      'now',
      blobCtx
    )
    expect(res0).toEqual({ type: 'STORE_BLOB', ok: true })
    expect(blobCtx.putBlob).not.toHaveBeenCalled()

    const res1 = processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'STORE_BLOB',
        uploadId: 'u2',
        seq: 1,
        total: 2,
        data: part1.toString('base64')
      }),
      'now',
      blobCtx
    )
    expect(res1).toMatchObject({
      type: 'STORE_BLOB',
      ok: true,
      size: part0.length + part1.length
    })
    expect(blobCtx.putBlob).toHaveBeenCalledTimes(1)
    expect(blobCtx.putBlob).toHaveBeenCalledWith(Buffer.concat([part0, part1]))
    expect(blobCtx.uploads.has('u2')).toBe(false)
  })

  it('STORE_BLOB rejects an upload that exceeds the 25MB cap', () => {
    const db = tempDb()
    const blobCtx = freshBlobCtx()
    const big = Buffer.alloc(25 * 1024 * 1024 + 1)
    const res = processChatImportHostMessage(
      db,
      JSON.stringify({
        type: 'STORE_BLOB',
        uploadId: 'u3',
        seq: 0,
        total: 1,
        data: big.toString('base64')
      }),
      'now',
      blobCtx
    )
    expect(res.type).toBe('ERROR')
    expect(blobCtx.putBlob).not.toHaveBeenCalled()
    expect(blobCtx.uploads.has('u3')).toBe(false)
  })

  it('INGEST keeps whitelisted attachments and drops malformed ones', () => {
    const db = tempDb()
    const hash = 'a'.repeat(64)
    const conv = {
      source: 'CHATGPT',
      externalId: 'c2',
      title: null,
      createdAt: null,
      updatedAt: null,
      messages: [
        {
          role: 'USER',
          idx: 0,
          text: 'hi',
          createdAt: null,
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              fileName: 'a.png',
              size: 10,
              width: 1,
              height: 1,
              hash
            },
            { kind: 'file', hash: 'not-64-hex' },
            { kind: 'video', hash },
            'not-an-object'
          ]
        }
      ]
    }
    const res = processChatImportHostMessage(db, JSON.stringify({ type: 'INGEST', conv }), 'now')
    expect(res).toEqual({ type: 'INGEST', ok: true, id: 'CHATGPT/c2' })
    expect(listMessageAttachments(db, 'CHATGPT/c2', 0)).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'a.png',
        size: 10,
        width: 1,
        height: 1,
        hash
      }
    ])
  })
})
