import type Database from '../../../sqlite/sync-database'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from '../db/lifecycle-transition'

/** A consistent count/window read must not acquire a writer reservation. */
export function readWorkerDockSnapshot<T>(db: Database.Database, read: () => T): T {
  if (db.isTransaction) {
    return read()
  }
  const transaction = beginLifecycleWriteTransaction(db, 'worker_dock_read', 'read')
  try {
    const result = read()
    commitLifecycleWriteTransaction(db, transaction)
    return result
  } catch (error) {
    rollbackLifecycleWriteTransaction(db, transaction)
    throw error
  }
}
