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

function insertRow(db: SyncDatabase, row: number, round: number): void {
  const words = Array.from({ length: 12 }, (_, at) => `term${(row * 13 + at * 7 + round) % 5000}`)
  insertSearchMessage(db, 1, { role: 'user', text: words.join(' '), timestamp: null })
}

/** Replaces one session's rows wholesale, as a whole reread of its transcript does. */
function replaceSession(db: SyncDatabase, round: number): void {
  db.exec('BEGIN')
  deleteSearchMessages(db, 1)
  for (let row = 0; row < ROWS; row++) {
    insertRow(db, row, round)
  }
  db.exec('COMMIT')
}

async function churnedStore(name: string, rounds: number) {
  const index = await openSessionSearchIndexFile(name)
  const store = new SessionSearchStore(index.path)
  const db = store.connection
  db.exec(`INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
    VALUES (1,'claude','one','one','compaction','')`)
  replaceSession(db, 0)
  const compact = ftsBytes(db)
  for (let round = 1; round <= rounds; round++) {
    replaceSession(db, round)
  }
  return { index, store, compact }
}

it('compacts an index whose replaced rows left their postings behind', async () => {
  const churned = await churnedStore('ss-index-compaction', 26)
  const { index, compact } = churned
  let store = churned.store
  try {
    expect(ftsBytes(store.connection)).toBeGreaterThan(compact * 2)

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

it('finishes compacting while indexing commits between its steps', async () => {
  const { index, store, compact } = await churnedStore('ss-index-compaction-busy', 24)
  try {
    const db = store.connection
    // 48,000 deletes: not yet due, so only this call compacts.
    let steps = 0
    await compactSessionSearchIndex(
      db,
      () => false,
      async () => {
        steps++
        insertRow(db, ROWS + steps, 0)
      }
    )
    expect(ftsBytes(db)).toBeLessThan(compact * 1.5)
  } finally {
    store.close()
    await index.close()
  }
})
