import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Why: OpenCode's schema has moved more than once, so every read probes for the
// columns it names. These are the two shapes the session parser depends on;
// keeping them here stops each reader from inventing its own partial gate.

/** Enough of `message` to count a session's turns. */
export function canCountOpenCodeMessages(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'message') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'data')
  )
}

/** Enough of `message`×`part` to read a session's parts in turn order. */
export function canReadOpenCodeMessageParts(db: SyncDatabase): boolean {
  return (
    canCountOpenCodeMessages(db) &&
    columnExists(db, 'message', 'id') &&
    // Every parts read orders by it; unprobed, a schema without it throws mid-read.
    columnExists(db, 'message', 'time_created') &&
    tableExists(db, 'part') &&
    columnExists(db, 'part', 'message_id') &&
    columnExists(db, 'part', 'time_created') &&
    columnExists(db, 'part', 'data')
  )
}
