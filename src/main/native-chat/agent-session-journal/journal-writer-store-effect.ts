import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreRowWrites } from '../../runtime/agent-session/records/agent-session-store-draft'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from '../../runtime/agent-session/records/agent-session-record-rows'
import type { JournalWriterEffect, JournalWriterStoreResult } from './journal-writer-effects'

/** Return the touched rows at the writer position, never a host's provisional copy. */
export function applyJournalWriterStoreEffect(
  db: Database.Database,
  effect: Extract<JournalWriterEffect, { kind: 'store' }>
): JournalWriterStoreResult {
  const { writes } = effect
  if (effect.insertOperationsIfAbsent) {
    insertAgentSessionOperationRowsIfAbsent(db, writes.operations.upsert)
  }
  writeAgentSessionStoreRows(
    db,
    effect.insertOperationsIfAbsent
      ? { ...writes, operations: { ...writes.operations, upsert: [] } }
      : writes
  )
  return {
    kind: 'store',
    disposition: 'applied',
    writes: {
      ...writes,
      records: resolvedRows(writes.records, (key) =>
        db
          .prepare('SELECT record_json AS json FROM agent_session_records WHERE session_id=?')
          .get(key)
      ),
      operations: resolvedRows(writes.operations, (key) =>
        db
          .prepare('SELECT row_json AS json FROM agent_session_operations WHERE operation_key=?')
          .get(key)
      )
    }
  }
}

function resolvedRows(
  touched: AgentSessionStoreRowWrites['records'],
  read: (key: string) => { json?: unknown } | undefined
): AgentSessionStoreRowWrites['records'] {
  const result: AgentSessionStoreRowWrites['records'] = { upsert: [], remove: [] }
  for (const key of new Set([...touched.upsert.map(([id]) => id), ...touched.remove])) {
    const row = read(key)
    if (!row) {
      result.remove.push(key)
    } else if (typeof row.json === 'string') {
      result.upsert.push([key, row.json])
    } else {
      throw new Error('a written store row has no saved form')
    }
  }
  return result
}
