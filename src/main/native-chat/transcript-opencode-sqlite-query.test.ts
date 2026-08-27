import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptPageAfter,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'

let tempDirs: string[] = []
let openDbs: Database.Database[] = []

afterEach(() => {
  // Why: Windows keeps the file locked while the handle is open, which would
  // make rmSync below fail with EPERM.
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

// The query module only touches these columns; the full production schema is
// exercised by the scanner's own suite.
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

describe('readOpenCodeTranscriptPage', () => {
  it('returns null when the session row does not exist', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    expect(readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'missing', limit: 10 })).toBeNull()
  })

  it('returns the NEWEST limit messages when more history exists', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let index = 1; index <= 10; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 3 })
    expect(page).not.toBeNull()
    // The probe row is the oldest extra — the newest message must survive.
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-8', 'msg-9', 'msg-10'])
    expect(page!.hasMore).toBe(true)
    expect(page!.beforeMessageRowId).toBe(page!.items[0]!.rowid)
  })

  it('pages strictly older messages from the raw-row cursor', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let index = 1; index <= 10; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
    const first = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 3 })
    const second = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId: 'ses-1',
      limit: 3,
      beforeMessageRowId: first!.beforeMessageRowId!
    })
    expect(second!.items.map((item) => item.message.id)).toEqual(['msg-5', 'msg-6', 'msg-7'])
  })

  it('counts the limit in renderable messages, batching past non-renderable rows', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Rows 1..6 alternate step-start (no blocks) / renderable — mirror of the
    // forward page's batching test, walking newest-to-oldest this time.
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
    // Two renderable messages even though they span three raw rows.
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-4', 'msg-6'])
    expect(page!.hasMore).toBe(true)
    // Cursor names the oldest RAW scanned row (msg-3, consumed but dropped),
    // so the probe row msg-2 comes back on the next page — nothing is skipped.
    expect(page!.beforeMessageRowId).toBe(
      (db.prepare('SELECT rowid AS r FROM message WHERE id = ?').get('msg-3') as { r: number }).r
    )
    const next = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId: 'ses-1',
      limit: 2,
      beforeMessageRowId: page!.beforeMessageRowId!
    })
    expect(next!.items.map((item) => item.message.id)).toEqual(['msg-2'])
    expect(next!.hasMore).toBe(false)
  })

  it('walks a fully non-renderable history to its oldest raw row without dead-ending', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let index = 1; index <= 4; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'step-start' }
      })
    }
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 2 })
    expect(page!.items).toEqual([])
    expect(page!.hasMore).toBe(false)
    // The raw cursor still names the oldest scanned row — a later renderable
    // append is picked up instead of being swallowed by the sparse prefix.
    expect(page!.beforeMessageRowId).toBe(
      (db.prepare('SELECT rowid AS r FROM message WHERE id = ?').get('msg-1') as { r: number }).r
    )
  })

  it('re-reads messages trimmed by an overshoot batch instead of skipping them', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Sparse-then-dense shape (reviewer repro): batch 1 yields one renderable
    // past a step-start row, batch 2 is dense and overshoots the budget.
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
    // Every renderable message returns exactly once — msg-2 must not fall
    // through the gap between the trimmed batch and the cursor. Pages arrive
    // newest-first (the walk starts at the tail), so chronological order
    // only holds inside each page.
    expect(seen).toEqual(['msg-3', 'msg-5', 'msg-1', 'msg-2'])
  })

  it('keeps hasMore true when a trim happens on the final short batch', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Batch 1 collects one renderable past a step-start; batch 2 hits the
    // table end (rows.length <= limit → probe says no more) while still
    // overshooting — the trim itself must keep the walk alive.
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
    // The overshoot trimmed msg-1 — that IS more history below the cursor.
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

  it('maps image file parts to image refs and skips non-image files', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // A file:// URL written on the READING machine's platform decodes back to
    // a local path; a foreign-platform one falls back to the opaque ref.
    const localPath = process.platform === 'win32' ? 'C:\\Users\\u\\pic.jpg' : '/home/user/pic.jpg'
    const fileUrl = pathToFileURL(localPath).href
    insertMessage(db, { id: 'msg-1', time: 1, role: 'user' })
    insertPart(db, {
      id: 'prt-data',
      messageId: 'msg-1',
      time: 1,
      data: {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,AAA',
        filename: 'paste.png'
      }
    })
    insertPart(db, {
      id: 'prt-file-url',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'file', mime: 'image/jpeg', url: fileUrl }
    })
    insertPart(db, {
      id: 'prt-plain-path',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'file', mime: 'image/webp', url: '/tmp/opencode/paste.webp' }
    })
    insertPart(db, {
      id: 'prt-pdf',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'file', mime: 'application/pdf', url: 'file:///tmp/doc.pdf' }
    })
    insertPart(db, {
      id: 'prt-text',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'text', text: 'prompt body' }
    })

    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 10 })
    // Blocks follow part-row order; the PDF (non-image) renders nothing.
    expect(page!.items[0]!.message.blocks).toEqual([
      { type: 'image-ref', url: 'data:image/png;base64,AAA', alt: 'paste.png' },
      { type: 'image-ref', path: localPath },
      { type: 'image-ref', path: '/tmp/opencode/paste.webp' },
      { type: 'text', text: 'prompt body' }
    ])
  })

  it('filters synthetic text parts and maps tool parts to call/result blocks', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMessage(db, { id: 'msg-1', time: 1, role: 'user' })
    insertPart(db, {
      id: 'prt-syn',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'text', text: 'injected context', synthetic: true }
    })
    insertPart(db, {
      id: 'prt-text',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'text', text: 'real prompt' }
    })
    insertMessage(db, { id: 'msg-2', time: 2, role: 'assistant' })
    insertPart(db, {
      id: 'prt-tool-done',
      messageId: 'msg-2',
      time: 2,
      data: {
        type: 'tool',
        tool: 'bash',
        callID: 'call-1',
        state: { status: 'completed', input: { command: 'ls' }, output: 'file list' }
      }
    })
    insertPart(db, {
      id: 'prt-tool-pending',
      messageId: 'msg-2',
      time: 2,
      data: { type: 'tool', tool: 'read', callID: 'call-2', state: { status: 'running' } }
    })

    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 10 })
    const user = page!.items.find((item) => item.message.id === 'msg-1')!
    expect(user.message.blocks).toEqual([{ type: 'text', text: 'real prompt' }])
    const assistant = page!.items.find((item) => item.message.id === 'msg-2')!
    expect(assistant.message.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'file list' },
      // A running tool captured no output yet — call only, no result block.
      { type: 'tool-call', name: 'read', input: undefined }
    ])
  })

  it('surfaces a tool error string as the result output', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMessage(db, { id: 'msg-1', time: 1, role: 'assistant' })
    insertPart(db, {
      id: 'prt-tool-error',
      messageId: 'msg-1',
      time: 1,
      data: {
        type: 'tool',
        tool: 'bash',
        callID: 'call-1',
        state: { status: 'error', input: { command: 'ls' }, error: 'exit 1: boom' }
      }
    })

    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 10 })
    expect(page!.items[0]!.message.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'exit 1: boom', isError: true }
    ])
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

    const signal = readOpenCodeTranscriptSignal(path, 'ses-1')
    expect(signal).toEqual({
      messageCount: 2,
      partCount: 2,
      maxMessageRowId: 2,
      maxPartTimeUpdated: 20
    })
  })

  it('returns null when the session row does not exist', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    expect(readOpenCodeTranscriptSignal(path, 'missing')).toBeNull()
  })
})

describe('readOpenCodeTranscriptPageAfter', () => {
  /** rowid of a message by id — rowids are implicit, so read them back. */
  function rowidOf(path: string, id: string): number {
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'ses-1', limit: 100 })
    const item = page!.items.find((candidate) => candidate.message.id === id)
    if (!item) {
      throw new Error(`message ${id} did not render; cannot read its rowid`)
    }
    return item.rowid
  }

  function seedRenderable(db: Database.Database, count: number): void {
    for (let index = 1; index <= count; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
  }

  it('returns null when the session row does not exist', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    expect(
      readOpenCodeTranscriptPageAfter({
        dbPath: path,
        sessionId: 'missing',
        afterMessageRowId: 0,
        limit: 10
      })
    ).toBeNull()
  })

  it('pages oldest-first after the cursor and reports hasMore via the probe', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    seedRenderable(db, 5)
    const afterFirst = rowidOf(path, 'msg-1')
    const page = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: afterFirst,
      limit: 2
    })
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-2', 'msg-3'])
    expect(page!.hasMore).toBe(true)
    expect(page!.nextMessageRowId).toBe(rowidOf(path, 'msg-3'))
    // The trimmed rows come back on the next continuation — nothing is skipped.
    const next = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: page!.nextMessageRowId,
      limit: 10
    })
    expect(next!.items.map((item) => item.message.id)).toEqual(['msg-4', 'msg-5'])
    expect(next!.hasMore).toBe(false)
    // Exhausted: the cursor holds and the walk is a no-op.
    const settled = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: next!.nextMessageRowId,
      limit: 10
    })
    expect(settled!.items).toEqual([])
    expect(settled!.hasMore).toBe(false)
    expect(settled!.nextMessageRowId).toBe(next!.nextMessageRowId)
  })

  it('counts the limit in renderable messages, batching past non-renderable rows', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Rows 1..6 alternate step-start (no blocks) / renderable.
    for (let index = 1; index <= 6; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: index % 2 === 0 ? { type: 'text', text: `message ${index}` } : { type: 'step-start' }
      })
    }
    const page = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: 0,
      limit: 2
    })
    // Two renderable messages even though they span four raw rows.
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-2', 'msg-4'])
    expect(page!.hasMore).toBe(true)
    expect(page!.nextMessageRowId).toBe(rowidOf(path, 'msg-4'))
  })

  it('advances the cursor over rows that never render so the walk cannot dead-end', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let index = 1; index <= 4; index++) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'step-start' }
      })
    }
    const rawRowid = (
      db.prepare('SELECT rowid AS r FROM message WHERE id = ?').get('msg-4') as { r: number }
    ).r
    const page = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: 0,
      limit: 2
    })
    expect(page!.items).toEqual([])
    expect(page!.hasMore).toBe(false)
    // The raw cursor still names the newest scanned row — a later renderable
    // append is picked up instead of being swallowed by the sparse prefix.
    expect(page!.nextMessageRowId).toBe(rawRowid)
    insertMessage(db, { id: 'msg-5', time: 5 })
    insertPart(db, {
      id: 'prt-5',
      messageId: 'msg-5',
      time: 5,
      data: { type: 'text', text: 'finally visible' }
    })
    const followUp = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: page!.nextMessageRowId,
      limit: 10
    })
    expect(followUp!.items.map((item) => item.message.id)).toEqual(['msg-5'])
  })

  it('keeps hasMore true when a trim happens on the final short batch', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    // Batch 1 collects one renderable past a step-start; batch 2 hits the
    // table end while still overshooting the budget — the trim itself must
    // keep the continuation alive or the newest message strands.
    insertMessage(db, { id: 'msg-1', time: 1 })
    insertPart(db, {
      id: 'prt-1',
      messageId: 'msg-1',
      time: 1,
      data: { type: 'step-start' }
    })
    for (const index of [2, 3, 4]) {
      insertMessage(db, { id: `msg-${index}`, time: index })
      insertPart(db, {
        id: `prt-${index}`,
        messageId: `msg-${index}`,
        time: index,
        data: { type: 'text', text: `message ${index}` }
      })
    }
    const first = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: 0,
      limit: 2
    })
    // Overshoot trimmed msg-4 — it is strictly newer than the returned cursor.
    expect(first!.items.map((item) => item.message.id)).toEqual(['msg-2', 'msg-3'])
    expect(first!.hasMore).toBe(true)
    const second = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: first!.nextMessageRowId,
      limit: 2
    })
    expect(second!.items.map((item) => item.message.id)).toEqual(['msg-4'])
    expect(second!.hasMore).toBe(false)
  })

  it('caps the walk at a frozen upper boundary', () => {
    const { db, path } = createTempDb()
    applySchema(db)
    seedRenderable(db, 6)
    const page = readOpenCodeTranscriptPageAfter({
      dbPath: path,
      sessionId: 'ses-1',
      afterMessageRowId: 0,
      limit: 10,
      upToMessageRowId: rowidOf(path, 'msg-3')
    })
    expect(page!.items.map((item) => item.message.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(page!.hasMore).toBe(false)
  })
})
