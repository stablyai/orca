import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionSearchSqliteAvailable', () => {
  it('registers no index on a host Node whose node:sqlite lacks backup()', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({
      DatabaseSync: function DatabaseSync() {}
    })
    expect(sessionSearchSqliteAvailable()).toBe(false)
  })

  it('registers no index on a host Node with no node:sqlite at all', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
    expect(sessionSearchSqliteAvailable()).toBe(false)
  })

  it('admits the full reader surface', () => {
    expect(sessionSearchSqliteAvailable()).toBe(true)
  })
})
