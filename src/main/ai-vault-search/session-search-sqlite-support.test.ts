import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionSearchSqliteAvailable', () => {
  it('rejects a SQLite surface without backup()', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({
      DatabaseSync: function DatabaseSync() {}
    })
    expect(sessionSearchSqliteAvailable()).toBe(false)
  })

  it('rejects a host without node:sqlite', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
    expect(sessionSearchSqliteAvailable()).toBe(false)
  })

  it('admits the full reader surface', () => {
    expect(sessionSearchSqliteAvailable()).toBe(true)
  })
})
