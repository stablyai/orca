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
    rollbackLifecycleWriteTransaction(db, transaction)
    throw error
  }
}
