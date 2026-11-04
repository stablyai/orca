import type Database from '../../../sqlite/sync-database'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from './lifecycle-transition'

export function runLifecycleWriteTransaction<T>(
  db: Database.Database,
  savepoint: string,
  operation: () => T
): T {
  const transaction = beginLifecycleWriteTransaction(db, savepoint)
  try {
    const result = operation()
    commitLifecycleWriteTransaction(db, transaction)
    return result
  } catch (error) {
    try {
      rollbackLifecycleWriteTransaction(db, transaction)
    } catch {
      // The failure that brought us here is the one to report; a rollback error such as
      // "cannot rollback - no transaction is active" must not replace it (#38123).
    }
    throw error
  }
}
