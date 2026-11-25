import { expect, it } from 'vitest'
import { CLAUDE_IMPORT_INDEX_BYTES, IndexBudget, Keys } from './journal-claude-import-index-storage'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

it('still finds a duplicate key when only growing the hash table would exhaust the budget', () => {
  const budget = new IndexBudget()
  budget.reserve(CLAUDE_IMPORT_INDEX_BYTES - 320 * 1024)
  const keys = new Keys(budget)
  try {
    for (let row = 0; row < 3072; row++) {
      keys.intern(`key-${row}`)
    }
    expect(() => keys.intern('another key')).toThrow(ClaudeImportResourceError)
    expect(keys.intern('key-0')).toBe(1)
  } finally {
    keys.dispose()
  }
})
