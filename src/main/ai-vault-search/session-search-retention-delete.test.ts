import { expect, it } from 'vitest'
import { inSessionParseFileLane } from '../ai-vault/session-parse-file-lane'
import type SyncDatabase from '../sqlite/sync-database'
import { discardSearchBatch } from './session-search-pending-deletes'
import {
  deleteExpiredSearchFiles,
  RETENTION_DELETE_ROWS_PER_STEP
} from './session-search-retention-delete'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'
import { SessionSearchStore } from './session-search-store'

function seed(db: SyncDatabase, id: number, rows: number, mtime: number): void {
  db.prepare(`INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,resume_command)
    VALUES (?, 'claude', ?, ?, 'synthetic retention', '/fixture', '/fixture', '')`).run(
    id,
    String(id),
    String(id)
  )
  db.prepare('INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES (?,1,?,?)').run(
    String(id),
    mtime,
    id
  )
  db.exec('BEGIN')
  for (let i = 0; i < rows; i++) {
    const row = db
      .prepare("INSERT INTO messages(session_row_id,role) VALUES (?,'user')")
      .run(id).lastInsertRowid
    db.prepare('INSERT INTO messages_fts(rowid,user_text) VALUES (?,?)').run(row, 'retentionneedle')
    db.prepare('INSERT INTO conversation_fts(rowid,user_text) VALUES (?,?)').run(
      row,
      'retentionneedle'
    )
  }
  db.exec('COMMIT')
}

/** Sessions a search over the visible views would still return. */
function visibleSessionIds(db: SyncDatabase): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM messages_fts
         JOIN visible_messages m ON m.id = messages_fts.rowid
         JOIN visible_sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH 'retentionneedle' ORDER BY s.session_id`
      )
      .all() as { id: string }[]
  ).map((row) => row.id)
}

function count(db: SyncDatabase, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

it('seeks the expiring end of the file list instead of scanning it', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-plan')
  try {
    seed(index.db, 1, 1, 1)
    const plan = (
      index.db
        .prepare('EXPLAIN QUERY PLAN SELECT path FROM files WHERE mtime_ms < ? ORDER BY mtime_ms')
        .all(100) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' ')
    // Without files_mtime this is "SCAN files" plus a "USE TEMP B-TREE FOR ORDER BY".
    expect(plan).toContain('files_mtime')
    expect(plan).not.toContain('TEMP B-TREE')
  } finally {
    await index.close()
  }
})

it('yields within a large file while hiding partial rows and preserving unrelated sessions', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-yield')
  seed(index.db, 1, 1025, 1)
  seed(index.db, 2, 1, 200)
  let previous = 1025
  let steps = 0
  try {
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => false,
      () => undefined,
      async () => {
        const left = count(index.db, 'messages WHERE session_row_id=1')
        expect(previous - left).toBeLessThanOrEqual(RETENTION_DELETE_ROWS_PER_STEP)
        expect(previous - left).toBeGreaterThan(0)
        previous = left
        steps++
        // The expiring session is hidden from the first step, never half-deleted.
        expect(visibleSessionIds(index.db)).toEqual(['2'])
      }
    )
    expect(steps).toBe(5)
    expect(count(index.db, 'messages_fts')).toBe(1)
    expect(count(index.db, 'conversation_fts')).toBe(1)
    expect(count(index.db, 'search_pending_deletes')).toBe(0)
  } finally {
    await index.close()
  }
})

it('finishes an interrupted deletion after reopening', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-resume')
  let store = new SessionSearchStore(index.path)
  let closed = false
  try {
    seed(index.db, 1, 513, 1)
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => closed,
      () => undefined,
      async () => {
        store.close()
        closed = true
      }
    )
    store = new SessionSearchStore(index.path)
    closed = false
    expect(visibleSessionIds(index.db)).toEqual([])
    // A durable tombstone survives the restart, so the rest goes even with
    // retention now unlimited.
    await store.purgeOlderThan(null)
    expect(count(index.db, 'messages_fts')).toBe(0)
    expect(count(index.db, 'sessions')).toBe(0)
  } finally {
    if (!closed) {
      store.close()
    }
    await index.close()
  }
})

it('does not orphan a replacement file when resuming an older deletion for the same path', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-reused-path')
  const store = new SessionSearchStore(index.path)
  try {
    seed(index.db, 1, 2, 1)
    index.db.exec(
      "INSERT INTO search_pending_deletes(path,session_row_id) VALUES ('1',1); DELETE FROM files WHERE path='1'"
    )
    seed(index.db, 2, 2, 1)
    index.db.exec("UPDATE files SET path='1' WHERE path='2'")
    await store.purgeOlderThan(100)
    for (const table of [
      'messages',
      'messages_fts',
      'conversation_fts',
      'sessions',
      'files',
      'search_pending_deletes'
    ]) {
      expect(count(index.db, table)).toBe(0)
    }
  } finally {
    store.close()
    await index.close()
  }
})

it('cancels retention between batches and resumes without exposing a partial session', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-cancel')
  const store = new SessionSearchStore(index.path)
  try {
    seed(index.db, 1, 1025, 1)
    const controller = new AbortController()
    const purge = store.purgeOlderThan(100, controller.signal)
    setImmediate(() => controller.abort())
    await purge
    const remaining = count(index.db, 'messages')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(1025)
    expect(visibleSessionIds(index.db)).toEqual([])
    await store.purgeOlderThan(null)
    expect(count(index.db, 'messages')).toBe(0)
  } finally {
    store.close()
    await index.close()
  }
})

it('never leaves a batch tombstone behind the batch row it names', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-orphan-batch')
  const db = index.db
  try {
    seed(db, 1, 1, 1)
    const batchId = Number(
      db.prepare('INSERT INTO search_write_batches(session_row_id) VALUES (?)').run(1)
        .lastInsertRowid
    )
    db.prepare("INSERT INTO messages(session_row_id,batch_id,role) VALUES (1,?,'user')").run(
      batchId
    )

    // Retention snapshots an empty tombstone set, then blocks on this path's
    // parse lane, which an in-flight read of the same file holds.
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const lane = inSessionParseFileLane('1', () => held)
    const purge = deleteExpiredSearchFiles(
      db,
      100,
      () => false,
      () => undefined
    )
    await new Promise((resolve) => setImmediate(resolve))

    // That read ends without publishing. It appended onto a session that is
    // live, so discard writes a batch-keyed tombstone instead of retiring one.
    discardSearchBatch(db, 1, batchId, false)
    release()
    await lane
    await purge

    // Retiring the session took the batch row with it, which frees the rowid.
    expect(count(db, 'search_write_batches')).toBe(0)
    expect(count(db, 'search_pending_deletes')).toBe(0)

    // The next read takes that rowid. A surviving tombstone for it would delete
    // this batch's staged rows, and the session would publish missing messages.
    seed(db, 2, 1, 100)
    const reused = Number(
      db.prepare('INSERT INTO search_write_batches(session_row_id) VALUES (?)').run(2)
        .lastInsertRowid
    )
    expect(reused).toBe(batchId)
    const staged = Number(
      db
        .prepare("INSERT INTO messages(session_row_id,batch_id,role) VALUES (2,?,'user')")
        .run(reused).lastInsertRowid
    )
    await deleteExpiredSearchFiles(
      db,
      null,
      () => false,
      () => undefined
    )
    expect(db.prepare('SELECT id FROM messages WHERE id=?').get(staged)).toBeDefined()
  } finally {
    await index.close()
  }
})
