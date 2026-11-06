import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'

let tempDirs: string[] = []
let openDbs: Database.Database[] = []

afterEach(() => {
  // Close before removal: Windows locks open databases.
  for (const db of openDbs) {
    db.close()
  }
  openDbs = []
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-native-chat-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  openDbs.push(db)
  return { db, path }
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    INSERT INTO session (id) VALUES ('ses-1'), ('ses-2');
  `)
}

function insertMessage(
  db: Database.Database,
  args: { id: string; sessionId?: string; time: number; role?: string }
): void {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  ).run(
    args.id,
    args.sessionId ?? 'ses-1',
    args.time,
    args.time,
    JSON.stringify({ role: args.role ?? 'user' })
  )
}

function insertPart(
  db: Database.Database,
  args: { id: string; messageId: string; sessionId?: string; time: number; data: unknown }
): void {
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  ).run(args.id, args.messageId, args.sessionId ?? 'ses-1', args.time, JSON.stringify(args.data))
}

function messageRowid(db: Database.Database, id: string): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite rows are unknown; the SELECT projects exactly one `r` integer column.
  return (db.prepare('SELECT rowid AS r FROM message WHERE id = ?').get(id) as { r: number }).r
}

describe('readOpenCodeTranscriptPage', () => {
  it('preserves ordinary text beside an oversized UTF-8 attachment part', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMessage(db, { id: 'msg', time: 1 })
    insertPart(db, {
      id: 'text',
      messageId: 'msg',
      time: 1,
      data: { type: 'text', text: 'see this' }
    })
    insertPart(db, {
      id: 'large',
      messageId: 'msg',
      time: 1,
      data: { type: 'file', mime: 'image/png', url: '😀'.repeat(600_000) }
    })
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 1 })
    expect(page?.items.map((item) => item.message)).toMatchObject([
      { id: 'msg', role: 'user', blocks: [{ type: 'text', text: 'see this' }] },
      {
        id: 'msg:omission',
        role: 'system',
        blocks: [{ type: 'text', presentation: 'history-item-too-large' }]
      }
    ])
    expect(page?.items[0]?.rowid).toBe(page?.items[1]?.rowid)
    expect(page?.items[0]?.message.transcriptOffset).toBe(page?.items[1]?.message.transcriptOffset)
  })

  it('counts the limit in renderable messages, batching past non-renderable rows', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let index = 1; index <= 6; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: index % 2 === 0 ? { type: 'text', text: `message ${index}` } : { type: 'step-start' }
      })
    }
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 2 })
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-4', 'msg-6'])
    expect(page!.hasMore).toBe(true)
    // Cursor tracks the oldest raw row, including filtered rows, so the probe survives for the next page.
    expect(page!.beforeMessageRowId).toBe(messageRowid(db, 'msg-3'))
    const next = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId: 'ses-1',
      limit: 2,
      beforeMessageRowId: page!.beforeMessageRowId!
    })
    expect(next!.items.map((item) => item.message.id)).toEqual(['msg-2'])
    expect(next!.hasMore).toBe(false)
  })

  it('re-reads messages trimmed by an overshoot batch instead of skipping them', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Sparse first batch then dense second batch must trim without skipping overflow.
    for (const index of [1, 2, 3, 5]) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
    insertMessage(db, { id: 'msg-4', time: 4 })
    insertPart(db, {
      id: 'prt-4',
      messageId: 'msg-4',
      time: 4,
      data: { type: 'step-start' }
    })
    const seen: string[] = []
    let cursor: number | null = null
    for (;;) {
      const page = readOpenCodeTranscriptPage({
        dbPath: path,
        sessionId: 'ses-1',
        limit: 2,
        ...(cursor !== null ? { beforeMessageRowId: cursor } : {})
      })
      seen.push(...page!.items.map((item) => item.message.id))
      if (!page!.hasMore) {
        break
      }
      cursor = page!.beforeMessageRowId
    }
    // Pages arrive newest-first; preserve order within each page and include every message once.
    expect(seen).toEqual(['msg-3', 'msg-5', 'msg-1', 'msg-2'])
  })

  it('keeps hasMore true when a trim happens on the final short batch', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // A final batch can overshoot despite reaching table end; trimming must retain hasMore.
    for (const index of [1, 2, 4]) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
    insertMessage(db, { id: 'msg-3', time: 3 })
    insertPart(db, {
      id: 'prt-3',
      messageId: 'msg-3',
      time: 3,
      data: { type: 'step-start' }
    })
    const first = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 2 })
    expect(first!.hasMore).toBe(true)
    const second = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId: 'ses-1',
      limit: 2,
      beforeMessageRowId: first!.beforeMessageRowId!
    })
    expect(second!.items.map((item) => item.message.id)).toEqual(['msg-1'])
    expect(second!.hasMore).toBe(false)
  })
})

describe('readOpenCodeTranscriptSignal', () => {
  it('aggregates counts and maxes per session', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMessage(db, { id: 'msg-1', time: 1 })
    insertMessage(db, { id: 'msg-2', time: 2 })
    insertMessage(db, { id: 'other-1', time: 3, sessionId: 'ses-2' })
    insertPart(db, { id: 'prt-1', messageId: 'msg-1', time: 10, data: { type: 'text', text: 'a' } })
    insertPart(db, { id: 'prt-2', messageId: 'msg-2', time: 20, data: { type: 'text', text: 'b' } })

    db.exec(
      "ALTER TABLE session ADD COLUMN directory TEXT; UPDATE session SET directory = '/folder'"
    )
    const signal = readOpenCodeTranscriptSignal(path, 'ses-1')
    expect(signal).toEqual({
      cwd: '/folder',
      messageCount: 2,
      partCount: 2,
      maxMessageRowId: 2,
      maxPartTimeUpdated: 20
    })
  })
})

it.each(['stop', 'tool-calls', undefined])(
  'uses native v1 completion evidence without treating prose or tool work as terminal: %s',
  async (finish) => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMessage(db, { id: 'u1', time: 1 })
    insertPart(db, { id: 'pu', messageId: 'u1', time: 1, data: { type: 'text', text: 'Prompt' } })
    insertMessage(db, { id: 'a1', time: 2, role: 'assistant' })
    insertPart(db, { id: 'pa', messageId: 'a1', time: 2, data: { type: 'text', text: 'Response' } })
    if (finish) {
      db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
        JSON.stringify({ role: 'assistant', time: { completed: 3 }, finish }),
        'a1'
      )
    }
    const imported = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => path,
      readPage: async (args) => readOpenCodeTranscriptPage(args)
    })
    expect(imported).toMatchObject({ forkTipItemIds: finish === 'stop' ? ['u1', 'a1'] : [] })
  }
)
