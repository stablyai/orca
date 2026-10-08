import type Database from '../sqlite/sync-database'

// Malformed rows must remain readable as absent, including while SQLite builds the indexes.
function field(path: string): string {
  return `CASE WHEN json_valid(row_json) THEN json_extract(row_json, '${path}') END`
}

export const OPERATION_ID_SQL = field('$.operationId')
export const OPERATION_EXPIRY_SQL = field('$.expiresAt')
export const OPERATION_WORKTREE_SQL = field('$.ownedPane.worktreeId')
export const OPERATION_PANE_SQL = field('$.ownedPane.paneKey')

export function ensureAgentSessionOperationIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS agent_session_operations_id
      ON agent_session_operations (${OPERATION_ID_SQL});
    CREATE INDEX IF NOT EXISTS agent_session_operations_expiry
      ON agent_session_operations (${OPERATION_EXPIRY_SQL});
    CREATE INDEX IF NOT EXISTS agent_session_operations_pane
      ON agent_session_operations (${OPERATION_WORKTREE_SQL}, ${OPERATION_PANE_SQL}, ${OPERATION_EXPIRY_SQL});
  `)
}
