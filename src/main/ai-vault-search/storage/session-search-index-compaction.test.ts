import { expect, it, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'
import { deleteSearchMessages, insertSearchMessage } from './session-search-message-rows'
import { compactSessionSearchIndex } from './session-search-index-compaction'

const ROWS = 2000

function ftsBytes(db: SyncDatabase): number {
  return Number(db.prepare('SELECT SUM(LENGTH(block)) AS n FROM messages_fts_data').get()!.n)
}

function insertRow(db: SyncDatabase, session: number, row: number, round: number): void {
  const words = Array.from({ length: 12 }, (_, at) => `term${(row * 13 + at * 7 + round) % 5000}`)
  insertSearchMessage(db, session, { role: 'user', text: words.join(' '), timestamp: null })
}

function writeSession(db: SyncDatabase, session: number, round: number): void {
  db.prepare(`INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
    VALUES (?,'claude','one','one','compaction','')`).run(session)
  for (let row = 0; row < ROWS; row++) {
    insertRow(db, session, row, round)
  }
}

/** A whole reread writes a new session row and orphans the old one's messages for the drain. */
function orphaningReplace(db: SyncDatabase, round: number): void {
  db.exec('BEGIN')
  writeSession(db, round + 1, round)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(round)
  db.exec('COMMIT')
}

/** Deletes in place, uncounted, so the store never finds compaction due by itself. */
function uncountedReplace(db: SyncDatabase, round: number): void {
  db.exec('BEGIN')
  deleteSearchMessages(db, 1)
  for (let row = 0; row < ROWS; row++) {
    insertRow(db, 1, row, round)
  }
  db.exec('COMMIT')
}

async function churnedStore(name: string, replace: (db: SyncDatabase, round: number) => void) {
  const index = await openSessionSearchIndexFile(name)
  const store = new SessionSearchStore(index.path)
  const db = store.connection
  db.exec('BEGIN')
  writeSession(db, 1, 0)
  db.exec('COMMIT')
  const compact = ftsBytes(db)
  for (let round = 1; round <= 26; round++) {
    replace(db, round)
  }
  return { index, store, compact }
}

it('compacts an index whose replaced rows left their postings behind', async () => {
  const churned = await churnedStore('ss-index-compaction', orphaningReplace)
  const { index, compact } = churned
  let store = churned.store
  try {
    expect(ftsBytes(store.connection)).toBeGreaterThan(compact * 2)

    // The next open drains the orphaned rows, finds those deletes due and compacts.
    store.close()
    store = new SessionSearchStore(index.path)
    await vi.waitFor(
      () => {
        expect(store.connection.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n).toBe(ROWS)
        expect(ftsBytes(store.connection)).toBeLessThan(compact * 1.5)
      },
      { timeout: 20_000 }
    )
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

it('finishes compacting while indexing commits between its steps', async () => {
  const { index, store, compact } = await churnedStore('ss-index-compaction-busy', uncountedReplace)
  try {
    const db = store.connection
    let steps = 0
    await compactSessionSearchIndex(
      db,
      () => false,
      async () => {
        steps++
        insertRow(db, 1, ROWS + steps, 0)
      }
    )
    expect(ftsBytes(db)).toBeLessThan(compact * 1.5)
  } finally {
    store.close()
    await index.close()
  }
})
