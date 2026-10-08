import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { readAgentSessionOperationSqlRow } from './agent-session-operation-repository'
import { OPERATION_EXPIRY_SQL } from './agent-session-operation-sql'

const EXPIRY_BATCH_SIZE = 256
const EXPIRY_INTERVAL_MS = 60_000

/** The cursor is disposable: expiry is re-derived from receipts after every host restart. */
export class AgentSessionOperationMaintenance {
  private cursor = { expiry: Number.MIN_SAFE_INTEGER, rowid: 0 }
  // Why: a lasting failure would log every tick into an unrotated remote orcad log.
  private failing = false

  constructor(private readonly host: JournalHostDatabase) {}

  run(now: number): void {
    if (this.host.readOnly || this.host.isClosed) {
      return
    }
    try {
      this.cursor = this.host.transaction((db) => {
        const rows = db
          .prepare(`SELECT operation_key, row_json, rowid,
            ${OPERATION_EXPIRY_SQL} AS expiry FROM agent_session_operations
          WHERE ${OPERATION_EXPIRY_SQL} <= ? AND ${OPERATION_EXPIRY_SQL} >= ?
            AND (${OPERATION_EXPIRY_SQL} > ? OR rowid > ?)
          ORDER BY ${OPERATION_EXPIRY_SQL}, rowid LIMIT ?`)
          .all(now, this.cursor.expiry, this.cursor.expiry, this.cursor.rowid, EXPIRY_BATCH_SIZE)
        const remove = db.prepare('DELETE FROM agent_session_operations WHERE operation_key = ?')
        for (const stored of rows) {
          const row = readAgentSessionOperationSqlRow(stored)
          if (row && row.expiresAt <= now) {
            remove.run(stored.operation_key)
          }
        }
        const last = rows.at(-1)
        // Unreadable rows stay intact without starving later receipts of maintenance.
        return rows.length === EXPIRY_BATCH_SIZE && last
          ? { expiry: Number(last.expiry), rowid: Number(last.rowid) }
          : { expiry: Number.MIN_SAFE_INTEGER, rowid: 0 }
      })
    } catch (error) {
      if (!this.failing) {
        console.warn('[agent-session-journal] expired operation receipt cleanup failed', error)
      }
      this.failing = true
      return
    }
    if (this.failing) {
      this.failing = false
      console.info('[agent-session-journal] expired operation receipt cleanup recovered')
    }
  }
}

export function startAgentSessionOperationMaintenance(host: JournalHostDatabase): () => void {
  if (host.readOnly) {
    return () => undefined
  }
  const maintenance = new AgentSessionOperationMaintenance(host)
  const timer = setInterval(() => maintenance.run(Date.now()), EXPIRY_INTERVAL_MS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's interval handle has unref; mobile's test typecheck sees React Native timers, typed as a number.
  const unrefable = timer as unknown as { unref?: () => void }
  unrefable.unref?.()
  return () => clearInterval(timer)
}
