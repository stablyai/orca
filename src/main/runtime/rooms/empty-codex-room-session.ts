import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import Database from '../../sqlite/sync-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../../native-chat/agent-session-journal/journal-database-schema'
import {
  journalDatabaseFile,
  journalDirectoryFor
} from '../../native-chat/agent-session-journal/journal-paths'
import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'

/** Missing history never permits replacing a session that may have received input. */
export function isEmptyCodexRoomSession(
  record: AgentSessionRecord | null | undefined,
  journalRoot: string,
  error: unknown
): record is AgentSessionRecord {
  const first = record?.providerHandleChain[0]
  if (
    !record ||
    record.provider !== 'codex' ||
    record.accountHome.variable !== 'CODEX_HOME' ||
    first?.origin !== 'created' ||
    first.handle.provider !== 'codex' ||
    !(error instanceof Error) ||
    error.message !==
      `codex app-server thread/resume failed: no rollout found for thread id ${first.handle.threadId}`
  ) {
    return false
  }
  const threadId = first.handle.threadId
  const { lease } = record
  if (
    lease.runtimeKind !== 'native' ||
    lease.claimStatus !== 'released' ||
    lease.unreconciled ||
    lease.ownerProcess ||
    lease.reservedSpawnToken ||
    lease.handoffStage ||
    lease.settlementRetryRequired ||
    record.providerHandleChain.some(
      (link) =>
        !['created', 'resumed'].includes(link.origin) ||
        link.handle.provider !== 'codex' ||
        link.handle.threadId !== threadId
    )
  ) {
    return false
  }
  try {
    const db = new Database(
      journalDatabaseFile(
        journalDirectoryFor(journalRoot, {
          workspaceId: record.location.workspaceId,
          sessionId: record.sessionId
        })
      ),
      { readonly: true, fileMustExist: true }
    )
    try {
      if (db.pragma('user_version', { simple: true }) !== JOURNAL_DB_SCHEMA_VERSION) {
        return false
      }
      // All epochs and raw rows, not a rendered tail that can hide old or removed input.
      const rows = db
        .prepare(`SELECT r.row_json, s.epoch FROM journal_rows r
        JOIN journal_sessions s ON s.session_id = r.session_id
        WHERE r.session_id = ? AND NOT EXISTS
          (SELECT 1 FROM journal_repairs WHERE session_id = r.session_id)
        ORDER BY r.seq LIMIT 257`)
        .all(record.sessionId)
      if (!rows.length || rows.length > 256) {
        return false
      }
      return rows.every((entry, index) => {
        const parsed = parseJournalRow(String(entry.row_json))
        if (!parsed.ok || parsed.row.epoch !== entry.epoch || parsed.row.seq !== index + 1) {
          return false
        }
        const row = parsed.row
        if (index === 0) {
          return (
            row.kind === 'epoch' &&
            row.reason === 'session_created' &&
            row.providerHandle.kind === 'codex' &&
            row.providerHandle.threadId === threadId
          )
        }
        return (
          row.kind === 'item' &&
          !row.turn &&
          row.body.kind === 'status' &&
          !row.body.turnLifecycle &&
          row.body.providerFrame?.provider === 'codex' &&
          [
            'notification:deprecationNotice',
            'notification:warning',
            'notification:mcpServer/startupStatus/updated'
          ].includes(row.body.providerFrame.kind)
        )
      })
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}
