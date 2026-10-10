import { describe, expect, it } from 'vitest'
import type { RelayDatabase } from './database.js'
import { readPostgresLockWaitSample } from './postgres-lock-wait-sample.js'

function sampled(rows: Array<Record<string, unknown>>): RelayDatabase {
  const database: RelayDatabase = {
    query: async () => rows,
    queryLocked: async () => rows,
    transaction: async (operation) => await operation(database),
    close: async () => undefined
  }
  return database
}

describe('lock-wait sample roles', () => {
  it('keeps combined-role sessions as their own class and folds unknown roles into other', async () => {
    const sample = await readPostgresLockWaitSample(
      sampled([
        { waiter_role: 'combined', waited_table: 'relay_cells', holder_role: 'combined', waiters: 2 },
        { waiter_role: 'psql', waited_table: 'relay_cells', holder_role: null, waiters: 1 }
      ])
    )
    expect(sample).toEqual([
      { waiterRole: 'combined', table: 'relay_cells', holderRole: 'combined', waiters: 2 },
      { waiterRole: 'other', table: 'relay_cells', holderRole: 'other', waiters: 1 }
    ])
  })
})
