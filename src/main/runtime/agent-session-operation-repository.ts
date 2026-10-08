import {
  agentSessionOperationKey,
  claimAgentSessionOperation,
  settleAgentSessionOperation,
  evaluateAgentSessionOperation,
  type AgentSessionOperationClaim,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationOwnedPane,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type Database from '../sqlite/sync-database'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { isReadableAgentSessionStoreOperation } from './agent-session-store-row-rules'
import {
  OPERATION_EXPIRY_SQL,
  OPERATION_ID_SQL,
  OPERATION_PANE_SQL,
  OPERATION_WORKTREE_SQL
} from './agent-session-operation-sql'

export function readAgentSessionOperationSqlRow(row: SqliteRow): AgentSessionOperationRow | null {
  if (typeof row.operation_key !== 'string' || typeof row.row_json !== 'string') {
    return null
  }
  try {
    const value: unknown = JSON.parse(row.row_json)
    return isReadableAgentSessionStoreOperation(row.operation_key, value) ? value : null
  } catch {
    return null
  }
}

function serializedOperation(row: AgentSessionOperationRow) {
  const key = agentSessionOperationKey(row.callerKey, row.operationId)
  const json = JSON.stringify(row)
  if (!isReadableAgentSessionStoreOperation(key, JSON.parse(json))) {
    throw new Error('agent_session_store_write_invalid')
  }
  return { key, json }
}

type OperationAdmission = {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}

/** Receipts have one authority: the host's journal connection, including its transaction. */
export class AgentSessionOperationRepository {
  private readonly present: boolean

  constructor(private readonly database: () => Database.Database) {
    this.present = Boolean(
      database()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_session_operations')
    )
  }

  get(callerKey: string, operationId: string): AgentSessionOperationRow | null {
    if (!this.present) {
      return null
    }
    const row = this.database()
      .prepare(
        'SELECT operation_key, row_json FROM agent_session_operations WHERE operation_key = ?'
      )
      .get(agentSessionOperationKey(callerKey, operationId))
    return row ? readAgentSessionOperationSqlRow(row) : null
  }

  find(operationId: string, now?: number): AgentSessionOperationRow | null {
    if (!this.present) {
      return null
    }
    const expiry = now === undefined ? '' : ` AND ${OPERATION_EXPIRY_SQL} > ?`
    const parameters = now === undefined ? [operationId] : [operationId, now]
    const rows = this.database()
      .prepare(`SELECT operation_key, row_json FROM agent_session_operations
        WHERE ${OPERATION_ID_SQL} = ?${expiry} ORDER BY rowid`)
      .iterate(...parameters)
    for (const stored of rows) {
      const row = readAgentSessionOperationSqlRow(stored)
      if (row) {
        return row
      }
    }
    return null
  }

  owningPane(pane: AgentSessionOperationOwnedPane, now: number): AgentSessionOperationRow[] {
    if (!this.present) {
      return []
    }
    return this.database()
      .prepare(`SELECT operation_key, row_json FROM agent_session_operations
        WHERE ${OPERATION_WORKTREE_SQL} = ? AND ${OPERATION_PANE_SQL} = ?
          AND ${OPERATION_EXPIRY_SQL} > ? ORDER BY rowid`)
      .all(pane.worktreeId, pane.paneKey, now)
      .flatMap((stored) => {
        const row = readAgentSessionOperationSqlRow(stored)
        return row ? [row] : []
      })
  }

  evaluate(args: OperationAdmission, global = false) {
    const existing = global
      ? this.find(args.operationId, args.now)
      : this.get(args.callerKey, args.operationId)
    const rows = new Map<string, AgentSessionOperationRow>()
    if (existing && existing.expiresAt > args.now) {
      rows.set(agentSessionOperationKey(args.callerKey, args.operationId), existing)
    }
    return evaluateAgentSessionOperation({ rows, ...args })
  }

  put(row: AgentSessionOperationRow): void {
    const db = this.writer()
    const { key, json } = serializedOperation(row)
    db.prepare(`INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)
      ON CONFLICT(operation_key) DO UPDATE SET row_json = excluded.row_json`).run(key, json)
  }

  claim(args: {
    callerKey: string
    operationId: string
    ownedPane?: AgentSessionOperationOwnedPane
    terminalCreate?: unknown
  }): AgentSessionOperationClaim {
    const db = this.writer()
    const existing = this.get(args.callerKey, args.operationId)
    const key = agentSessionOperationKey(args.callerKey, args.operationId)
    const claim = claimAgentSessionOperation(new Map(existing ? [[key, existing]] : []), args).claim
    if (claim.claim !== 'won') {
      return claim
    }
    const { json } = serializedOperation(claim.row)
    const changed = db
      .prepare(`UPDATE agent_session_operations SET row_json = ?
      WHERE operation_key = ? AND json_extract(row_json, '$.outcome.status') = 'pending'`)
      .run(json, key)
    if (Number(changed.changes) !== 1) {
      throw new Error('agent_session_operation_claim_conflict')
    }
    return claim
  }

  settle(args: {
    callerKey?: string
    operationId: string
    outcome: AgentSessionOperationOutcome
  }): void {
    this.writer()
    const rows = args.callerKey
      ? [this.get(args.callerKey, args.operationId)]
      : this.database()
          .prepare(`SELECT operation_key, row_json FROM agent_session_operations
            WHERE ${OPERATION_ID_SQL} = ? ORDER BY rowid`)
          .all(args.operationId)
          .map(readAgentSessionOperationSqlRow)
    const matching = new Map(
      rows.flatMap((row) =>
        row ? [[agentSessionOperationKey(row.callerKey, row.operationId), row] as const] : []
      )
    )
    for (const [key, row] of settleAgentSessionOperation(matching, args)) {
      if (row !== matching.get(key)) {
        this.put(row)
      }
    }
  }

  private writer(): Database.Database {
    const db = this.database()
    if (!db.isTransaction) {
      throw new Error('agent_session_operation_transaction_required')
    }
    return db
  }
}
