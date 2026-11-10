import type Database from '../../sqlite/sync-database'
import {
  readPRWatchStorage,
  type PRWatchRead,
  type PRWatchReadValues
} from '../../github/pr-watch/pr-watch-storage'
import { loadAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type { AgentSessionStoreState } from '../../runtime/agent-session/records/agent-session-store-state'
import { readCommandReceipt } from './writing/command-receipt-table'
import type { CommandReceiptScope } from './writing/command-receipt-schema'

export type JournalSqlStoredRecords = Omit<AgentSessionStoreState, 'sessionTabs'> & {
  sessionTabs: [tabId: string, sessionId: string][] | null
}

export type JournalSqlDatabaseRead =
  | { kind: 'pr-watch'; operation: PRWatchRead }
  | { kind: 'records'; unreconciled?: true }
  | { kind: 'receipt'; scope: CommandReceiptScope; operationId: string }
  | { kind: 'epoch'; sessionId: string }
  | { kind: 'sessions'; after: string | null }
  | { kind: 'retired-heads'; after: string | null; through: string | null }
  | { kind: 'attachment-claims'; after: number }
  | { kind: 'attachment-sweeps'; after: string | null }

export type JournalSqlDatabaseReadResult =
  | { kind: 'pr-watch'; value: PRWatchReadValues[PRWatchRead['kind']] }
  | { kind: 'records'; records: JournalSqlStoredRecords }
  | { kind: 'receipt'; receipt: ReturnType<typeof readCommandReceipt> }
  | { kind: 'epoch'; epoch: string | null }
  | { kind: 'sessions'; sessionIds: string[] }
  | {
      kind: 'retired-heads'
      heads: { sessionId: string; epoch: string }[]
      through: string | null
    }
  | {
      kind: 'attachment-claims'
      claims: { rowid: number; uploadId: string; sessionId: string }[]
    }
  | { kind: 'attachment-sweeps'; uploadIds: string[] }

/** Profile metadata has no chat projection prerequisite; all reads still share one WAL snapshot. */
export function readJournalSqlDatabase(
  db: Database.Database,
  operation: JournalSqlDatabaseRead
): JournalSqlDatabaseReadResult {
  db.exec('BEGIN')
  try {
    const result = read(db, operation)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function read(
  db: Database.Database,
  operation: JournalSqlDatabaseRead
): JournalSqlDatabaseReadResult {
  switch (operation.kind) {
    case 'pr-watch':
      return { kind: 'pr-watch', value: readPRWatchStorage(db, operation.operation) }
    case 'records': {
      const records = loadAgentSessionStoreRows(db, operation.unreconciled)
      return {
        kind: 'records',
        records: { ...records, sessionTabs: records.sessionTabs?.entries() ?? null }
      }
    }
    case 'receipt':
      return {
        kind: 'receipt',
        receipt: readCommandReceipt(db, operation.scope, operation.operationId)
      }
    case 'epoch':
      return {
        kind: 'epoch',
        epoch:
          db
            .prepare(
              'SELECT epoch FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL'
            )
            .get(operation.sessionId)
            ?.epoch?.toString() ?? null
      }
    case 'sessions': {
      const rows =
        operation.after === null
          ? db
              .prepare('SELECT session_id FROM journal_chat_state ORDER BY session_id LIMIT 32')
              .all()
          : db
              .prepare(`SELECT session_id FROM journal_chat_state
                WHERE session_id>? ORDER BY session_id LIMIT 32`)
              .all(operation.after)
      return { kind: 'sessions', sessionIds: rows.map((row) => String(row.session_id)) }
    }
    case 'retired-heads': {
      const through =
        operation.through ??
        db
          .prepare(
            'SELECT session_id FROM journal_chat_state WHERE epoch IS NOT NULL ORDER BY session_id DESC LIMIT 1'
          )
          .get()?.session_id
      if (through === undefined) {
        return { kind: 'retired-heads', heads: [], through: null }
      }
      const rows =
        operation.after === null
          ? db
              .prepare(`SELECT session_id,epoch FROM journal_chat_state
                WHERE epoch IS NOT NULL AND session_id<=? ORDER BY session_id LIMIT 16`)
              .all(through)
          : db
              .prepare(`SELECT session_id,epoch FROM journal_chat_state
                WHERE epoch IS NOT NULL AND session_id>? AND session_id<=? ORDER BY session_id LIMIT 16`)
              .all(operation.after, through)
      return {
        kind: 'retired-heads',
        heads: rows.map((row) => ({ sessionId: String(row.session_id), epoch: String(row.epoch) })),
        through: String(through)
      }
    }
    case 'attachment-claims':
      return {
        kind: 'attachment-claims',
        claims: db
          .prepare(`SELECT rowid, upload_id, session_id FROM agent_session_attachment_claims
            WHERE rowid>? ORDER BY rowid LIMIT 128`)
          .all(operation.after)
          .map((row) => ({
            rowid: Number(row.rowid),
            uploadId: String(row.upload_id),
            sessionId: String(row.session_id)
          }))
      }
    case 'attachment-sweeps': {
      const rows =
        operation.after === null
          ? db
              .prepare(`SELECT upload_id FROM agent_session_attachment_sweeps
                ORDER BY upload_id LIMIT 128`)
              .all()
          : db
              .prepare(`SELECT upload_id FROM agent_session_attachment_sweeps
                WHERE upload_id>? ORDER BY upload_id LIMIT 128`)
              .all(operation.after)
      return { kind: 'attachment-sweeps', uploadIds: rows.map((row) => String(row.upload_id)) }
    }
  }
}
