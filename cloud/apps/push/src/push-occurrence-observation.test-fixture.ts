import type { PushDatabase } from './push-database.js'

export type AuthorityWork = {
  sql: string
  params: unknown[]
  rows: number
  changes: number
  returning: number
  parameterBytes: number
  returnedBytes: number
  outcome: 'entered' | 'returned' | 'error'
  error?: unknown
}
export type AuthorityActivity = {
  transactions: {
    attempts: number
    errors: unknown[]
    outcome: 'entered' | 'committed' | 'error'
    error?: unknown
  }[]
  advisory: {
    method: string
    key: string
    outcome: 'entered' | 'returned' | 'error'
    result?: boolean | void
    error?: unknown
  }[]
}
export function observeAuthority(
  db: PushDatabase,
  work: AuthorityWork[],
  locks: string[],
  activity: AuthorityActivity = { transactions: [], advisory: [] }
): PushDatabase {
  async function advisory<T>(method: string, key: string, run: () => Promise<T>): Promise<T> {
    const entry: AuthorityActivity['advisory'][number] = { method, key, outcome: 'entered' }
    activity.advisory.push(entry)
    try {
      const result = await run()
      entry.outcome = 'returned'
      if (typeof result === 'boolean') {
        entry.result = result
      }
      return result
    } catch (error) {
      entry.outcome = 'error'
      entry.error = error
      throw error
    }
  }
  return {
    dialect: db.dialect,
    lockQuotaScope: (key) => advisory('lockQuotaScope', key, () => db.lockQuotaScope(key)),
    tryLockSharedScope: (key) =>
      advisory('tryLockSharedScope', key, () => db.tryLockSharedScope(key)),
    close: () => db.close(),
    query: async (sql, params = []) => {
      const entry: AuthorityWork = {
        sql,
        params,
        rows: 0,
        changes: 0,
        returning: 0,
        parameterBytes: Buffer.byteLength(JSON.stringify(params)),
        returnedBytes: 0,
        outcome: 'entered'
      }
      work.push(entry)
      try {
        const rows = await db.query(sql, params)
        entry.rows = rows.length
        entry.returnedBytes = Buffer.byteLength(JSON.stringify(rows))
        entry.changes = rows.reduce(
          (sum, row) => sum + (typeof row.changes === 'number' ? row.changes : 0),
          0
        )
        entry.returning = /returning/i.test(sql) ? rows.length : 0
        entry.outcome = 'returned'
        return rows
      } catch (error) {
        entry.outcome = 'error'
        entry.error = error
        throw error
      }
    },
    lockScope: async (key) => {
      locks.push(key)
      await advisory('lockScope', key, () => db.lockScope(key))
    },
    tryLockScope: async (key) => {
      locks.push(key)
      return advisory('tryLockScope', key, () => db.tryLockScope(key))
    },
    transaction: async (run) => {
      const entry: AuthorityActivity['transactions'][number] = {
        attempts: 0,
        errors: [],
        outcome: 'entered'
      }
      activity.transactions.push(entry)
      try {
        const result = await db.transaction(async (tx) => {
          entry.attempts++
          try {
            return await run(observeAuthority(tx, work, locks, activity))
          } catch (error) {
            entry.errors.push(error)
            throw error
          }
        })
        entry.outcome = 'committed'
        return result
      } catch (error) {
        entry.outcome = 'error'
        entry.error = error
        throw error
      }
    }
  }
}
