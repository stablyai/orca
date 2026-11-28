import type Database from '../../sqlite/sync-database'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'
export function applyProtectedSessionGrant(
  db: Database.Database,
  operation: Extract<JournalSqlMaintenance, { kind: 'protected-founding' | 'protected-session' }>
) {
  switch (operation.kind) {
    case 'protected-founding': {
      db.prepare(
        'INSERT OR IGNORE INTO journal_export_sessions(session_id,workspace_id,provider,founding_op) VALUES(?,?,?,?)'
      ).run(operation.sessionId, operation.workspaceId, operation.provider, operation.operationId)
      if (
        !db
          .prepare(
            'SELECT 1 FROM journal_export_sessions WHERE session_id=? AND workspace_id=? AND provider=? AND founding_op=?'
          )
          .get(
            operation.sessionId,
            operation.workspaceId,
            operation.provider,
            operation.operationId
          )
      ) {
        throw new Error('conflicting protected founding')
      }
      return null
    }
    case 'protected-session': {
      const grant = db
        .prepare(
          'SELECT provider FROM journal_export_sessions WHERE session_id=? AND workspace_id=?'
        )
        .get(operation.sessionId, operation.workspaceId)
      if (
        grant
          ? operation.provider !== undefined && grant.provider !== operation.provider
          : !db
              .prepare('SELECT 1 FROM journal_chat_state WHERE session_id=? AND workspace_id=?')
              .get(operation.sessionId, operation.workspaceId)
      ) {
        throw new Error('session is neither migrated nor founded in the protected host')
      }
      return null
    }
  }
}
