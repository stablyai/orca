import { describe, expect, it } from 'vitest'
import { SessionSearchStore } from './session-search-store'
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
    ({ input, candidate, copies, exact, expected }) => {
      const store = new SessionSearchStore(':memory:')
      try {
        const insert = store.db.prepare('INSERT INTO messages_fts(user_text) VALUES (?)')
        for (let i = 0; i < copies; i++) {
          insert.run(candidate)
        }
        if (exact) {
          insert.run(input)
        }
        expect(new SessionSearchTypoRepair(store.db).correct(input)).toBe(expected)
      } finally {
        store.close()
      }
    }
  )
})
