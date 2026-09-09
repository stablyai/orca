import { describe, expect, it } from 'vitest'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

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
        const insert = index.db.prepare('INSERT INTO messages_fts(user_text) VALUES (?)')
        for (let i = 0; i < copies; i++) {
          insert.run(candidate)
        }
        if (exact) {
          insert.run(input)
        }
        expect(new SessionSearchTypoRepair(index.db).correct(input)).toBe(expected)
      } finally {
        await index.close()
      }
    }
  )

  // Mid-write the closest term can be one no reader can see yet. Abandoning the
  // prefix there would lose a repair the published index can already serve.
  it('falls through to the best visible candidate when the closest one is staged', async () => {
    const index = await openSessionSearchIndexFile('ss-typo-staged')
    try {
      const { db } = index
      db.prepare(
        `INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
         VALUES (1, 'claude', '1', '/synthetic/1', 'staged fixture', '')`
      ).run()
      db.prepare('INSERT INTO search_write_batches(id, session_row_id) VALUES (1, 1)').run()
      const message = db.prepare(
        "INSERT INTO messages(session_row_id, batch_id, role) VALUES (1, ?, 'user')"
      )
      const text = db.prepare('INSERT INTO messages_fts(rowid, user_text) VALUES (?, ?)')
      // `coalesces` scores higher against `coalescs` than `coalesced` does, and
      // shares its prefix, so only the fall-through can reach the visible one.
      for (const [term, batch] of [
        ['coalesces', 1],
        ['coalesces', 1],
        ['coalesced', null],
        ['coalesced', null]
      ] as const) {
        text.run(Number(message.run(batch).lastInsertRowid), term)
      }
      expect(new SessionSearchTypoRepair(db).correct('coalescs')).toBe('coalesced')
    } finally {
      await index.close()
    }
  })
})
