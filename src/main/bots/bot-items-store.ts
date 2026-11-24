// Bot items on this host (bot-items.sqlite, next to bot-work.sqlite): one row of current state per
// item and an append-only event log, each write one transaction with any mail it owes. The status machine and who may write which field are enforced inside those transactions.
import SyncDatabase from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { BotItemError } from './bot-item-error'
import { ensureKeptWaitingAsks } from './bot-item-waiting-ask-keep'
import { migrateBotItems } from './bot-items-schema'
import { BotItemsOwner } from './bot-items-owner'

export { BotItemError }

export class BotItemsStore extends BotItemsOwner {
  /** The file lives in the profile folder, which exists before any runtime reads it. */
  static open(path: string): BotItemsStore {
    const db = new SyncDatabase(path)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    const writable = migrateBotItems(db)
    if (writable) {
      ensureKeptWaitingAsks(db)
    }
    if (path !== ':memory:') {
      hardenSqliteDatabaseFiles(path)
    }
    return new BotItemsStore(db, !writable)
  }
}
