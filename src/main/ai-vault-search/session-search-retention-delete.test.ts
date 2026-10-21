import { expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import {
  deleteExpiredSearchFiles,
  RETENTION_DELETE_ROWS_PER_STEP
} from './session-search-retention-delete'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

function seed(db: SyncDatabase, id: number, rows: number, mtime: number): void {
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,resume_command)
    VALUES (?, 'claude', ?, ?, 'synthetic retention', '/fixture', '/fixture', '')`
  ).run(id, String(id), String(id))
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
  }
  db.exec('COMMIT')
}

/**
 * Sessions a search would still return. Every retrieval joins a message to its
 * session, which is what makes cutting the session loose enough to hide the
 * whole thing while its rows are still being reclaimed.
 */
function visibleSessionIds(db: SyncDatabase): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
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

it('hides an expiring session at once, then reclaims its rows in bounded steps', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-yield')
  seed(index.db, 1, 1025, 1)
  seed(index.db, 2, 1, 200)
  let previous = 1025
  const steps: number[] = []
  try {
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => false,
      async () => {
        const left = count(index.db, 'messages WHERE session_row_id=1')
        steps.push(previous - left)
        previous = left
        // Cut loose in the very first transaction, so no query ever sees it with
        // some of its messages already gone.
        expect(visibleSessionIds(index.db)).toEqual(['2'])
      }
    )
    // The file transaction, then one bounded batch per step until the rows are gone.
    expect(steps).toEqual([0, RETENTION_DELETE_ROWS_PER_STEP, 256, 256, 256, 1])
    expect(count(index.db, 'messages_fts')).toBe(1)
    expect(count(index.db, 'sessions')).toBe(1)
  } finally {
    await index.close()
  }
})

it('finishes an interrupted deletion after reopening', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-resume')
  let store = new SessionSearchStore(index.path)
  let closed = false
  let steps = 0
  try {
    seed(index.db, 1, 513, 1)
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => closed,
      async () => {
        if (++steps === 2) {
          store.close()
          closed = true
        }
      }
    )
    // Some rows went, the rest did not, and nothing recorded that anywhere.
    const stranded = count(index.db, 'messages')
    expect(stranded).toBeGreaterThan(0)
    expect(stranded).toBeLessThan(513)
    expect(visibleSessionIds(index.db)).toEqual([])

    store = new SessionSearchStore(index.path)
    closed = false
    // Rows nothing points at are the whole record of unfinished work, so the
    // rest goes even with retention now unlimited.
    await store.purgeOlderThan(null)
    expect(count(index.db, 'messages')).toBe(0)
    expect(count(index.db, 'messages_fts')).toBe(0)
  } finally {
    if (!closed) {
      store.close()
    }
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

it('keeps a file a read refreshed after the expiry list was taken', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-refreshed')
  try {
    seed(index.db, 1, 2, 1)
    seed(index.db, 2, 2, 2)
    let refreshed = false
    // The scan of `files` happens once, up front. A read of the second transcript
    // lands while the first is being deleted, which makes it new enough to keep.
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => false,
      async () => {
        if (!refreshed) {
          refreshed = true
          index.db.prepare('UPDATE files SET mtime_ms = 500 WHERE path = ?').run('2')
        }
      }
    )

    // Only the per-file transaction re-reading the mtime it is about to act on
    // keeps that session; the list it came from says both should go.
    expect(count(index.db, 'files')).toBe(1)
    expect(visibleSessionIds(index.db)).toEqual(['2'])
    expect(count(index.db, 'messages')).toBe(2)
  } finally {
    await index.close()
  }
})
