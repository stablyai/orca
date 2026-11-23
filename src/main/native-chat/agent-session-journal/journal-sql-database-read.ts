import type Database from '../../sqlite/sync-database'
import {
  readPRWatchStorage,
  type PRWatchRead,
  type PRWatchReadValues
} from '../../github/pr-watch/pr-watch-storage'
import { loadAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type { AgentSessionStoreState } from '../../runtime/agent-session/records/agent-session-store-state'
import {
  storedAgentSessionBackground,
  type StoredAgentSessionBackground
} from '../../runtime/agent-session/records/agent-session-tab-table'
import { readCommandReceipt } from './writing/command-receipt-table'
import type { CommandReceiptScope } from './writing/command-receipt-schema'
import {
  journalLegacyCopySourceKey,
  journalLegacyFailureKey
} from './database/journal-legacy-source'
import {
  pendingJournalLegacyCompares,
  type JournalLegacyCompare
} from './database/journal-legacy-compare'
import { readForgottenJournalChats } from './journal-forgotten-chats'
import { readDeletedChats } from './journal-deleted-chats'
import type { DeletedChat } from '../chat-deletion/deleted-chats'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from './connector-replies/journal-connector-replies-read'
import type { JournalConnectorReplyRow } from '../../../shared/agent-session/journal/journal-connector-reply'

export type JournalSqlStoredRecords = Omit<AgentSessionStoreState, 'sessionTabs'> & {
  sessionTabs: [tabId: string, sessionId: string][] | null
  backgroundSessions: StoredAgentSessionBackground | null
}

/** Background conversion leaves a copy whose history failed to convert to an open. */
const UNFAILED_COPY = `NOT EXISTS (SELECT 1 FROM agent_session_store_meta f
  WHERE f.key='${journalLegacyFailureKey('')}'||c.session_id
    AND EXISTS (SELECT 1 FROM agent_session_store_meta m
      WHERE m.key='${journalLegacyCopySourceKey('')}'||c.session_id))`

/** A pending chat; epoch is null once its head is gone, generation settles exactly this entry. */
export type JournalRetiredHead = { sessionId: string; epoch: string | null; generation: number }

export type JournalSqlDatabaseRead =
  | { kind: 'pr-watch'; operation: PRWatchRead }
  | { kind: 'records'; unreconciled?: true }
  | { kind: 'receipt'; scope: CommandReceiptScope; operationId: string }
  | { kind: 'epoch'; sessionId: string }
  | { kind: 'sessions'; after: string | null }
  | { kind: 'waiting-card-sessions'; sessionIds: readonly string[] }
  | { kind: 'retired-heads'; after: string | null; through: string | null }
  | { kind: 'attachment-claims'; after: number }
  | { kind: 'attachment-sweeps'; after: string | null }
  | { kind: 'legacy-compares'; after: string | null }
  | { kind: 'forgotten-chats'; after: string | null }
  | { kind: 'deleted-chats' }
  | { kind: 'connector-replies'; sessionId?: string }
  | { kind: 'connector-replies-owed'; account: string; after: string | null; limit: number }

export type JournalSqlDatabaseReadResult =
  | { kind: 'pr-watch'; value: PRWatchReadValues[PRWatchRead['kind']] }
  | { kind: 'records'; records: JournalSqlStoredRecords }
  | { kind: 'receipt'; receipt: ReturnType<typeof readCommandReceipt> }
  | { kind: 'epoch'; epoch: string | null }
  | { kind: 'sessions'; sessionIds: string[] }
  | { kind: 'legacy-compares'; compares: JournalLegacyCompare[] }
  | { kind: 'retired-heads'; heads: JournalRetiredHead[]; through: string | null }
  | {
      kind: 'attachment-claims'
      claims: { rowid: number; uploadId: string; sessionId: string }[]
    }
  | { kind: 'attachment-sweeps'; uploadIds: string[] }
  | { kind: 'forgotten-chats'; sessionIds: string[] }
  | { kind: 'deleted-chats'; chats: DeletedChat[] }
  | { kind: 'connector-replies'; rows: JournalConnectorReplyRow[] }

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
        records: {
          ...records,
          sessionTabs: records.sessionTabs?.entries() ?? null,
          backgroundSessions: storedAgentSessionBackground(records.sessionTabs)
        }
      }
    }
    case 'receipt':
      return {
        kind: 'receipt',
        receipt: readCommandReceipt(db, operation.scope, operation.operationId)
      }
    case 'connector-replies':
      return {
        kind: 'connector-replies',
        rows: readJournalConnectorReplies(db, operation.sessionId)
      }
    case 'connector-replies-owed':
      return {
        kind: 'connector-replies',
        rows: readOwedJournalConnectorReplies(
          db,
          operation.account,
          operation.after,
          operation.limit
        )
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
    case 'legacy-compares':
      return {
        kind: 'legacy-compares',
        compares: pendingJournalLegacyCompares(db, operation.after)
      }
    case 'sessions': {
      const rows =
        operation.after === null
          ? db
              .prepare(
                `SELECT session_id FROM journal_chat_state c WHERE ${UNFAILED_COPY} ORDER BY session_id LIMIT 32`
              )
              .all()
          : db
              .prepare(`SELECT session_id FROM journal_chat_state c
                WHERE session_id>? AND ${UNFAILED_COPY} ORDER BY session_id LIMIT 32`)
              .all(operation.after)
      return { kind: 'sessions', sessionIds: rows.map((row) => String(row.session_id)) }
    }
    case 'waiting-card-sessions': {
      // The cards' (session_id, epoch) key prefix keeps each probe to one chat's current cards.
      const waiting = db.prepare(`SELECT 1 FROM journal_chat_state AS head
        JOIN journal_queue_cards AS card
          ON card.session_id=head.session_id AND card.epoch=head.epoch
        WHERE head.session_id=? AND card.state='waiting' LIMIT 1`)
      return {
        kind: 'sessions',
        sessionIds: operation.sessionIds.filter((sessionId) => waiting.get(sessionId) !== undefined)
      }
    }
    case 'retired-heads': {
      // A pass ends at the highest key pending when it began, so later arrivals can't extend it.
      const through =
        operation.through ??
        db.prepare('SELECT max(session_id) AS through FROM journal_retire_pending').get()?.through
      if (through === null || through === undefined) {
        return { kind: 'retired-heads', heads: [], through: null }
      }
      // The first page has no lower bound; later pages keep an indexed range from the cursor.
      const after = operation.after === null ? '' : 'pending.session_id>? AND '
      const rows = db
        .prepare(`SELECT pending.session_id,pending.generation,head.epoch FROM journal_retire_pending AS pending
          LEFT JOIN journal_chat_state AS head ON head.session_id=pending.session_id
          WHERE ${after}pending.session_id<=? ORDER BY pending.session_id LIMIT 16`)
        .all(...(operation.after === null ? [through] : [operation.after, through]))
      return {
        kind: 'retired-heads',
        through: String(through),
        heads: rows.map((row) => ({
          sessionId: String(row.session_id),
          epoch: row.epoch === null || row.epoch === undefined ? null : String(row.epoch),
          generation: Number(row.generation)
        }))
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
    case 'forgotten-chats':
      return { kind: 'forgotten-chats', sessionIds: readForgottenJournalChats(db, operation.after) }
    case 'deleted-chats':
      return { kind: 'deleted-chats', chats: readDeletedChats(db) }
  }
}
