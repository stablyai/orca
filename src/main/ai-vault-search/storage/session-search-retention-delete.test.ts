import { expect, it, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import { deleteExpiredSearchFiles, drainOrphanedMessages } from './session-search-retention-delete'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'
import {
  addSyntheticSession,
  openSessionSearchHarness
} from '../query/session-search-engine-test-fixture'
import { readIndexContentRevision, readIndexGeneration } from './session-search-index-generation'

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

it('continues frozen pages while reclaiming already-hidden orphan messages', async () => {
  const index = await openSessionSearchHarness('ss-orphan-paging')
  try {
    for (let id = 1; id <= 7; id++) {
      addSyntheticSession(index.db, { id, text: 'needle' })
    }
    addSyntheticSession(index.db, { id: 20, text: 'needle', rows: 1537 })
    index.db.exec('DELETE FROM sessions WHERE id = 20; DELETE FROM files WHERE session_row_id = 20')
    const request = { query: 'needle', limit: 1 }
    const first = index.engine.search(request)
    const before = readIndexContentRevision(index.db)
    const seen = first.hits.map((hit) => hit.sessionId)
    let cursor = first.page.cursor
    await drainOrphanedMessages(
      index.db,
      () => false,
      async () => {
        if (cursor) {
          const page = index.engine.search({ ...request, cursor })
          seen.push(...page.hits.map((hit) => hit.sessionId))
          cursor = page.page.cursor
        }
      }
    )
    expect(seen).toEqual(['7', '6', '5', '4', '3', '2', '1'])
    expect(cursor).toBeNull()
    expect(readIndexContentRevision(index.db)).toBe(before)
    expect(readIndexGeneration(index.db)).toBeGreaterThan(first.generation)
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
    const stranded = count(index.db, 'messages')
    expect(stranded).toBeGreaterThan(0)
    expect(stranded).toBeLessThan(513)
    expect(visibleSessionIds(index.db)).toEqual([])

    store = new SessionSearchStore(index.path)
    closed = false
    // Orphaned rows must drain even after retention becomes unlimited.
    await store.purgeOlderThan(null)
    await vi.waitFor(() => expect(count(index.db, 'messages')).toBe(0))
    expect(count(index.db, 'messages_fts')).toBe(0)
  } finally {
    if (!closed) {
      store.close()
    }
    await index.close()
  }
})

it('stops reclaiming after its database closes between batches', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-close')
  const store = new SessionSearchStore(index.path)
  let closed = false
  try {
    seed(store.connection, 1, 513, 1)
    store.connection.exec('DELETE FROM sessions WHERE id = 1')
    await expect(
      drainOrphanedMessages(
        store.connection,
        () => closed,
        async () => {
          closed = true
          store.close()
        }
      )
    ).resolves.toBeUndefined()
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
    expect(visibleSessionIds(index.db)).toEqual([])
    await store.purgeOlderThan(null)
    await vi.waitFor(() => expect(count(index.db, 'messages')).toBe(0))
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
    // Refresh the second file after the expiry snapshot but before its deletion transaction.
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

    expect(count(index.db, 'files')).toBe(1)
    expect(visibleSessionIds(index.db)).toEqual(['2'])
    expect(count(index.db, 'messages')).toBe(2)
  } finally {
    await index.close()
  }
})
