import type { PushDatabase } from './push-database.js'

// Caps worker and prune traffic at poolMax - 1 connections so request-path lookups always find one.
export function reserveRequestConnection(database: PushDatabase, poolMax: number): PushDatabase {
  const capacity = Math.max(1, poolMax - 1)
  let active = 0
  const waiting: (() => void)[] = []
  const admit = async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= capacity) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  return {
    dialect: database.dialect,
    query: (sql, params) => admit(() => database.query(sql, params)),
    transaction: (operation) => admit(() => database.transaction(operation)),
    lockQuotaScope: (key) => database.lockQuotaScope(key),
    tryLockScope: (key) => database.tryLockScope(key),
    tryLockSharedScope: (key) => database.tryLockSharedScope(key),
    close: () => database.close()
  }
}
