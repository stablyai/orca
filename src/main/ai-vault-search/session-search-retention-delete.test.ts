import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import {
  deleteExpiredSearchFiles,
  RETENTION_DELETE_ROWS_PER_STEP
} from './session-search-retention-delete'

function seed(store: SessionSearchStore, id: number, rows: number, mtime: number) {
  const db = store.db
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
  const store = new SessionSearchStore(':memory:')
  seed(store, 1, 1025, 1)
  seed(store, 2, 1, 200)
  let previous = 1025
  let steps = 0
  try {
    await deleteExpiredSearchFiles(
      store.db,
      100,
      () => false,
      () => {},
      async () => {
        const left = Number(
          (
            store.db.prepare('SELECT count(*) AS n FROM messages WHERE session_row_id=1').get() as {
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
    expect(store.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 1 })
    expect(store.db.prepare('SELECT count(*) AS n FROM conversation_fts').get()).toEqual({ n: 1 })
    expect(store.db.prepare('SELECT count(*) AS n FROM search_pending_deletes').get()).toEqual({
      n: 0
    })
  } finally {
    store.close()
  }
})

it('finishes an interrupted deletion after reopening even when history becomes unlimited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-retention-resume-'))
  const path = join(root, 'index.sqlite')
  let store = new SessionSearchStore(path)
  let closed = false
  try {
    seed(store, 1, 513, 1)
    await deleteExpiredSearchFiles(
      store.db,
      100,
      () => closed,
      () => {},
      async () => {
        store.close()
        closed = true
      }
    )
    store = new SessionSearchStore(path)
    closed = false
    expect(store.search({ query: 'retentionneedle' }).hits).toEqual([])
    expect(store.coverage().sessionsIndexed).toBe(0)
    await store.purgeOlderThan(null)
    expect(store.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 0 })
    expect(store.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  } finally {
    if (!closed) {
      store.close()
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('does not orphan a replacement file when resuming an older deletion for the same path', async () => {
  const store = new SessionSearchStore(':memory:')
  try {
    seed(store, 1, 2, 1)
    store.db.exec(
      "INSERT INTO search_pending_deletes VALUES ('1',1); DELETE FROM files WHERE path='1'"
    )
    seed(store, 2, 2, 1)
    store.db.exec("UPDATE files SET path='1' WHERE path='2'")
    await store.purgeOlderThan(100)
    for (const table of [
      'messages',
      'messages_fts',
      'conversation_fts',
      'sessions',
      'files',
      'search_pending_deletes'
    ]) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  } finally {
    store.close()
  }
})

it('cancels retention between batches and resumes without exposing a partial session', async () => {
  const store = new SessionSearchStore(':memory:')
  try {
    seed(store, 1, 1025, 1)
    const controller = new AbortController()
    const purge = store.purgeOlderThan(100, controller.signal)
    setImmediate(() => controller.abort())
    await purge
    const remaining = store.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
    expect(remaining.n).toBeGreaterThan(0)
    expect(remaining.n).toBeLessThan(1025)
    expect(store.search({ query: 'retentionneedle' }).hits).toEqual([])
    await store.purgeOlderThan(null)
    expect(store.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  } finally {
    store.close()
  }
})
