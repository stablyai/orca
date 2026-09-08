import { expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchStore } from './session-search-store'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'
import {
  deleteExpiredSearchFiles,
  RETENTION_DELETE_ROWS_PER_STEP
} from './session-search-retention-delete'

function seed(db: SyncDatabase, id: number, rows: number, mtime: number) {
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

it('yields within a large file while hiding partial rows and preserving unrelated sessions', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-yield')
  const store = new SessionSearchStore(index.path)
  seed(index.db, 1, 1025, 1)
  seed(index.db, 2, 1, 200)
  let previous = 1025
  let steps = 0
  try {
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => false,
      () => {},
      async () => {
        const left = Number(
          (
            index.db.prepare('SELECT count(*) AS n FROM messages WHERE session_row_id=1').get() as {
              n: number
            }
          ).n
        )
        expect(previous - left).toBeLessThanOrEqual(RETENTION_DELETE_ROWS_PER_STEP)
        expect(previous - left).toBeGreaterThan(0)
        previous = left
        steps++
        expect(store.search({ query: 'retentionneedle' }).hits.map((h) => h.sessionId)).toEqual([
          '2'
        ])
      }
    )
    expect(steps).toBe(5)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 1 })
    expect(index.db.prepare('SELECT count(*) AS n FROM conversation_fts').get()).toEqual({ n: 1 })
    expect(index.db.prepare('SELECT count(*) AS n FROM search_pending_deletes').get()).toEqual({
      n: 0
    })
  } finally {
    store.close()
    await index.close()
  }
})

it('finishes an interrupted deletion after reopening even when history becomes unlimited', async () => {
  const index = await openSessionSearchIndexFile('ss-retention-resume')
  let store = new SessionSearchStore(index.path)
  let closed = false
  try {
    seed(index.db, 1, 513, 1)
    await deleteExpiredSearchFiles(
      index.db,
      100,
      () => closed,
      () => {},
      async () => {
        store.close()
        closed = true
      }
    )
    store = new SessionSearchStore(index.path)
    closed = false
    expect(store.search({ query: 'retentionneedle' }).hits).toEqual([])
    expect(store.coverage().sessionsIndexed).toBe(0)
    await store.purgeOlderThan(null)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 0 })
    expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
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
      expect(index.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
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
    const remaining = index.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
    expect(remaining.n).toBeGreaterThan(0)
    expect(remaining.n).toBeLessThan(1025)
    expect(store.search({ query: 'retentionneedle' }).hits).toEqual([])
    await store.purgeOlderThan(null)
    expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  } finally {
    store.close()
    await index.close()
  }
})
