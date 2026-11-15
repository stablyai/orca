import { describe, expect, it } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import { openSessionSearchIndexFile } from '../storage/session-search-index-test-fixture'
import { ensureSessionSearchQuerySchema } from '../storage/session-search-query-schema'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

function addSession(db: SyncDatabase, id: number): void {
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
     VALUES (?, 'claude', ?, '/synthetic/fixture', 'typo fixture', '')`
  ).run(id, String(id))
}

function addTerm(db: SyncDatabase, sessionRowId: number, term: string): void {
  const rowid = db
    .prepare("INSERT INTO messages(session_row_id, role) VALUES (?, 'user')")
    .run(sessionRowId).lastInsertRowid
  db.prepare('INSERT INTO messages_fts(rowid, user_text) VALUES (?, ?)').run(Number(rowid), term)
}

describe('typo repair policy', () => {
  it('falls through to the best candidate a reader can still reach', async () => {
    const index = await openSessionSearchIndexFile('ss-typo-orphaned')
    try {
      const { db } = index
      ensureSessionSearchQuerySchema(db)
      addSession(db, 1)
      // The closer match belongs to absent session 2, simulating an unfinished orphan drain.
      for (const [term, session] of [
        ['coalesces', 2],
        ['coalesces', 2],
        ['coalesced', 1],
        ['coalesced', 1]
      ] as const) {
        addTerm(db, session, term)
      }
      expect(db.prepare("SELECT doc FROM messages_vocab WHERE term='coalesces'").get()).toEqual({
        doc: 2
      })
      expect(new SessionSearchTypoRepair(db).correct('coalescs', 'all')).toBe('coalesced')
    } finally {
      await index.close()
    }
  })
})
