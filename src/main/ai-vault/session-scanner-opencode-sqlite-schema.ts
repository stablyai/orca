import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

// Centralize schema probes so readers tolerate release differences without inconsistent partial guards.

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
    columnExists(db, 'message', 'time_created') &&
    tableExists(db, 'part') &&
    columnExists(db, 'part', 'message_id') &&
    columnExists(db, 'part', 'time_created') &&
    columnExists(db, 'part', 'data')
  )
}
