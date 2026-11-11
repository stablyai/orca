import type SyncDatabase from '../sqlite/sync-database'

const initialized = new WeakSet<SyncDatabase>()

/** Configuring TEMP storage deletes live TEMP objects, so every owner enters here first. */
export function initializeSessionSearchStorage(db: SyncDatabase): void {
  if (initialized.has(db)) {
    return
  }
  db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-1024')
  initialized.add(db)
}
