import { expect, it, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

const ROWS = 2000

function ftsBytes(db: SyncDatabase): number {
  return Number(db.prepare('SELECT SUM(LENGTH(block)) AS n FROM messages_fts_data').get()!.n)
}

/** Replaces one session's rows wholesale, as a whole reread of its transcript does. */
function replaceSession(db: SyncDatabase, round: number): void {
  db.exec('BEGIN')
  for (const { id } of db.prepare('SELECT id FROM messages WHERE session_row_id = 1').all()) {
    db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
    db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }
  for (let row = 0; row < ROWS; row++) {
    const id = db
      .prepare("INSERT INTO messages(session_row_id, role) VALUES (1, 'user')")
      .run().lastInsertRowid
    const words = Array.from({ length: 12 }, (_, at) => `term${(row * 13 + at * 7 + round) % 5000}`)
    db.prepare('INSERT INTO messages_fts(rowid, user_text) VALUES (?, ?)').run(id, words.join(' '))
  }
  db.exec('COMMIT')
}

it('compacts an index whose replaced rows left their postings behind', async () => {
  const index = await openSessionSearchIndexFile('ss-index-compaction')
  let store = new SessionSearchStore(index.path)
  try {
    const db = store.connection
    db.exec(`INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
      VALUES (1,'claude','one','one','compaction','')`)
    replaceSession(db, 0)
    const compact = ftsBytes(db)
    for (let round = 1; round <= 26; round++) {
      replaceSession(db, round)
    }
    const churned = ftsBytes(db)
    expect(churned).toBeGreaterThan(compact * 2)

    // The next open finds the deletes due and compacts in the background.
    store.close()
    store = new SessionSearchStore(index.path)
    await vi.waitFor(() => expect(ftsBytes(store.connection)).toBeLessThan(compact * 1.5), {
      timeout: 20_000
    })
    expect(store.connection.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n).toBe(ROWS)
    expect(
      store.connection
        .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'term7'")
        .get()!.n
    ).toBeGreaterThan(0)
  } finally {
    store.close()
    await index.close()
  }
})
