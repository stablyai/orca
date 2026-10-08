import { OPERATION_ID_SQL } from './agent-session-operation-sql'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { readAgentSessionOperationSqlRow } from './agent-session-operation-repository'

/** Whole-ledger assertions belong in tests; production readers use indexed queries. */
export function readTestAgentSessionOperationRows(
  store: AgentSessionRecordStore | null | undefined
) {
  if (!store) {
    return []
  }
  return store['transactions']['journalDatabase'].db
    .prepare('SELECT operation_key, row_json FROM agent_session_operations ORDER BY rowid')
    .all()
    .flatMap((stored) => {
      const row = readAgentSessionOperationSqlRow(stored)
      return row ? [row] : []
    })
}

export function deleteTestAgentSessionOperation(
  store: AgentSessionRecordStore,
  operationId: string
): void {
  store['transactions']['journalDatabase'].transaction((db) => {
    db.prepare(`DELETE FROM agent_session_operations WHERE ${OPERATION_ID_SQL} = ?`).run(
      operationId
    )
  })
}
