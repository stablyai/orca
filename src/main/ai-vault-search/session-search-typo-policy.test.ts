import { describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

/** A session row the planted messages below hang off, so a repair can see them. */
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
  it.each([
    { input: 'coalesces', candidate: 'coalesced', copies: 2, exact: true, expected: null },
    { input: 'coalescs', candidate: 'coalesces', copies: 1, exact: false, expected: null },
    { input: 'coalescs', candidate: 'coalesces', copies: 2, exact: false, expected: 'coalesces' },
    { input: 'café', candidate: 'cafe', copies: 1, exact: false, expected: null },
    { input: 'car', candidate: 'cars', copies: 2, exact: false, expected: null },
    { input: 'calm', candidate: 'clam', copies: 2, exact: false, expected: null }
  ])(
    'repairs $input to $expected with $copies postings (exact=$exact)',
    async ({ input, candidate, copies, exact, expected }) => {
      const index = await openSessionSearchIndexFile('ss-typo-policy')
      try {
        ensureSessionSearchQuerySchema(index.db)
        addSession(index.db, 1)
        for (let i = 0; i < copies; i++) {
          addTerm(index.db, 1, candidate)
        }
        if (exact) {
          addTerm(index.db, 1, input)
        }
        expect(new SessionSearchTypoRepair(index.db).correct(input, 'all')).toBe(expected)
      } finally {
        await index.close()
      }
    }
  )

  // A purge cuts a session loose in one transaction and reclaims its rows over
  // many, so the vocabulary can still list a term whose only rows nothing can
  // reach. Abandoning the prefix at that term would lose a repair the rest of
  // the index can already serve.
  it('falls through to the best candidate a reader can still reach', async () => {
    const index = await openSessionSearchIndexFile('ss-typo-orphaned')
    try {
      const { db } = index
      ensureSessionSearchQuerySchema(db)
      addSession(db, 1)
      // `coalesces` scores higher against `coalescs` than `coalesced` does, and
      // shares its prefix, so only the fall-through can reach the reachable one.
      // Session 2 is never created: these rows are what an unfinished purge
      // leaves behind, and the vocabulary counts them all the same.
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
