import type Database from '../../sqlite/sync-database'
import { journalOpenRefusalError } from './journal-open-failure'
import { AgentSessionJournalError } from './journal-write-guards'
import {
  contextTransferRecordSchema,
  type ContextTransferDelivery,
  type ContextTransferHandoff,
  type ContextTransferRecord,
  type ContextTransferTarget
} from './context-transfer-record'

// Each keyed query below repeats these expressions and partial predicates exactly, so every term is an index key.
export const CONTEXT_TRANSFER_INDEX_SQL = `
DROP INDEX IF EXISTS agent_session_context_transfer_format;
DROP INDEX IF EXISTS agent_session_context_transfer_delivery_carrier;
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_kind
  ON agent_session_context_transfers(session_id, kind);
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_delivery_target
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.targetId'), json_extract(record_json, '$.outcome.kind'))
  WHERE kind = 'delivery';
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_delivery_started
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.targetId'), json_extract(record_json, '$.outcome.kind'))
  WHERE kind = 'delivery' AND json_extract(record_json, '$.writeStartedAt') IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_inline_carrier
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.carrierInputId'), json_extract(record_json, '$.outcome.kind'))
  WHERE kind = 'delivery' AND json_extract(record_json, '$.mode') = 'inline';
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_closure_command
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.commandId'))
  WHERE kind = 'closure';
`

const COLUMNS = 'id, session_id, handoff_id, kind, format, record_json'
const TABLE = 'agent_session_context_transfers'
const STARTED = `kind = 'delivery' AND json_extract(record_json, '$.writeStartedAt') IS NOT NULL`
const INLINE = `kind = 'delivery' AND json_extract(record_json, '$.mode') = 'inline'`

/** Every keyed read returns whole rows; each must visit only the rows it returns. */
export const CONTEXT_TRANSFER_KEYED_SQL = {
  any: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? LIMIT 1`,
  byId: `SELECT ${COLUMNS} FROM ${TABLE} WHERE id = ?`,
  newestTarget: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'target' ORDER BY rowid DESC LIMIT 1`,
  closed: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND handoff_id = ? AND kind = 'closure' LIMIT 1`,
  delivered: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'delivery' AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') IN ('injected', 'inline-accepted', 'not-required') LIMIT 1`,
  startedWithoutOutcome: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND ${STARTED} AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') IS NULL LIMIT 1`,
  startedUnknown: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND ${STARTED} AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') = 'unknown' LIMIT 1`,
  carriersWithoutOutcome: `SELECT rowid AS at, ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND ${INLINE} AND json_extract(record_json, '$.carrierInputId') = ? AND json_extract(record_json, '$.outcome.kind') IS NULL ORDER BY rowid`,
  carriersUnknown: `SELECT rowid AS at, ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND ${INLINE} AND json_extract(record_json, '$.carrierInputId') = ? AND json_extract(record_json, '$.outcome.kind') = 'unknown' ORDER BY rowid`,
  closedByCommand: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'closure' AND json_extract(record_json, '$.commandId') = ? LIMIT 1`,
  newestClosure: `SELECT rowid AS at, ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'closure' ORDER BY rowid DESC LIMIT 1`,
  handoffsAfter: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'handoff' AND rowid > ? ORDER BY rowid`
} as const
const SQL = CONTEXT_TRANSFER_KEYED_SQL

/** The one whole-chat read: every saved row, whatever its kind, format or bytes. */
export const CONTEXT_TRANSFER_AUDIT_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ?`

export function unreadableContextTransfer(): never {
  throw journalOpenRefusalError(
    new AgentSessionJournalError(
      'journal_read_only',
      'Saved context transfer cannot be read by this Orca'
    )
  )
}

function readableContextTransferRow(row: Record<string, unknown>): ContextTransferRecord | null {
  if (row.format !== 1 || typeof row.record_json !== 'string') {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(row.record_json)
  } catch {
    return null
  }
  const decoded = contextTransferRecordSchema.safeParse(value)
  if (!decoded.success) {
    return null
  }
  const record = decoded.data
  return record.id === row.id &&
    record.sessionId === row.session_id &&
    record.handoffId === row.handoff_id &&
    record.kind === row.kind
    ? record
    : null
}

/** A row's bytes are this build's format and say what its columns say, or the chat refuses. */
export function decodeContextTransferRow(row: Record<string, unknown>): ContextTransferRecord {
  return readableContextTransferRow(row) ?? unreadableContextTransfer()
}

/** SQLite raises on malformed stored JSON reached by an expression; that is unreadable data, not a crash. */
function query<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      return unreadableContextTransfer()
    }
    throw error
  }
}

// Decoded rows live only until the transaction that may change them ends, or a write replaces them.
const decoded = new WeakMap<Database.Database, Map<string, ContextTransferRecord>>()

export function forgetContextTransferRows(db: Database.Database): void {
  decoded.delete(db)
}

export function forgetContextTransferRow(db: Database.Database, id: string): void {
  decoded.get(db)?.delete(id)
}

// Whether every saved row of a chat decoded on this connection; only validated writes follow until it reopens.
const audited = new WeakMap<Database.Database, Map<string, boolean>>()

export function forgetContextTransferAudit(db: Database.Database, sessionId: string): void {
  audited.get(db)?.delete(sessionId)
}

/** Keyed reads of one chat's transfer facts; SQL on this connection is the only authority. */
export class ContextTransferFacts {
  constructor(
    private readonly db: Database.Database,
    readonly sessionId: string
  ) {}

  /** Once per connection, every row of the chat must decode, so a missing keyed row is a real absence. */
  audit(): void {
    let sessions = audited.get(this.db)
    if (!sessions) {
      sessions = new Map()
      audited.set(this.db, sessions)
    }
    const known = sessions.get(this.sessionId)
    if (known === undefined) {
      let readable = true
      for (const row of this.db.prepare(CONTEXT_TRANSFER_AUDIT_SQL).iterate(this.sessionId)) {
        if (!readableContextTransferRow(row)) {
          readable = false
          break
        }
      }
      sessions.set(this.sessionId, readable)
      if (!readable) {
        unreadableContextTransfer()
      }
    } else if (!known) {
      unreadableContextTransfer()
    }
  }

  any(): boolean {
    return this.witness(SQL.any, this.sessionId) !== undefined
  }

  record(id: string): ContextTransferRecord | undefined {
    this.audit()
    const known = decoded.get(this.db)?.get(id)
    if (known) {
      return known.sessionId === this.sessionId ? known : undefined
    }
    const row = this.db.prepare(SQL.byId).get(id)
    if (!row || row.session_id !== this.sessionId) {
      return undefined
    }
    return this.decode(row)
  }

  handoff(id: string): ContextTransferHandoff | undefined {
    const record = this.record(id)
    return record?.kind === 'handoff' ? record : undefined
  }

  target(id: string): ContextTransferTarget | undefined {
    const record = this.record(id)
    return record?.kind === 'target' ? record : undefined
  }

  delivery(id: string): ContextTransferDelivery | undefined {
    const record = this.record(id)
    return record?.kind === 'delivery' ? record : undefined
  }

  /** Clear and rewind close every open handoff at once, so the newest target is current unless closed. */
  currentTarget(): ContextTransferTarget | undefined {
    const target = this.witness(SQL.newestTarget, this.sessionId)
    if (!target) {
      return undefined
    }
    if (target.kind !== 'target') {
      return unreadableContextTransfer()
    }
    return this.closed(target.handoffId) ? undefined : target
  }

  closed(handoffId: string): boolean {
    const closure = this.witness(SQL.closed, this.sessionId, handoffId)
    return !!closure && agrees(closure.kind === 'closure' && closure.handoffId === handoffId)
  }

  delivered(targetId: string): boolean {
    const delivery = this.witness(SQL.delivered, this.sessionId, targetId)
    return (
      !!delivery &&
      agrees(
        delivery.kind === 'delivery' &&
          delivery.targetId === targetId &&
          (delivery.outcome?.kind === 'injected' ||
            delivery.outcome?.kind === 'inline-accepted' ||
            delivery.outcome?.kind === 'not-required')
      )
    )
  }

  /** A started write with no final outcome: either no outcome yet or a recorded unknown. */
  uncertain(targetId: string): boolean {
    const started = (sql: string, outcome: 'unknown' | null) => {
      const delivery = this.witness(sql, this.sessionId, targetId)
      return (
        !!delivery &&
        agrees(
          delivery.kind === 'delivery' &&
            delivery.targetId === targetId &&
            delivery.writeStartedAt !== undefined &&
            (delivery.outcome?.kind ?? null) === outcome
        )
      )
    }
    return started(SQL.startedWithoutOutcome, null) || started(SQL.startedUnknown, 'unknown')
  }

  /** Inline deliveries this input carried that still await a final outcome. */
  carriers(inputId: string): ContextTransferDelivery[] {
    this.audit()
    const rows = [SQL.carriersWithoutOutcome, SQL.carriersUnknown]
      .flatMap((sql) => query(() => this.db.prepare(sql).all(this.sessionId, inputId)))
      .sort((a, b) => Number(a.at) - Number(b.at))
    return rows.map((row) => {
      const record = this.decode(row)
      if (
        record.kind !== 'delivery' ||
        record.mode !== 'inline' ||
        record.carrierInputId !== inputId ||
        (record.outcome !== null && record.outcome.kind !== 'unknown')
      ) {
        return unreadableContextTransfer()
      }
      return record
    })
  }

  closedByCommand(commandId: string): boolean {
    const closure = this.witness(SQL.closedByCommand, this.sessionId, commandId)
    return !!closure && agrees(closure.kind === 'closure' && closure.commandId === commandId)
  }

  /** Every handoff before the newest closure was closed with it, so open ones are newer. */
  openHandoffs(): string[] {
    this.audit()
    const newest = query(() => this.db.prepare(SQL.newestClosure).get(this.sessionId))
    if (newest) {
      agrees(this.decode(newest).kind === 'closure')
    }
    const after = typeof newest?.at === 'number' ? newest.at : 0
    return this.db
      .prepare(SQL.handoffsAfter)
      .all(this.sessionId, after)
      .map((row) => {
        const handoff = this.decode(row)
        agrees(handoff.kind === 'handoff')
        return handoff.id
      })
  }

  /** The one row a keyed query selected, decoded; a row that fails decoding refuses rather than being skipped. */
  private witness(sql: string, ...params: string[]): ContextTransferRecord | undefined {
    this.audit()
    const row = query(() => this.db.prepare(sql).get(...params))
    return row ? this.decode(row) : undefined
  }

  /** A row already decoded in this transaction is the same bytes; writes and rollbacks evict it. */
  private decode(row: Record<string, unknown>): ContextTransferRecord {
    const known = typeof row.id === 'string' ? decoded.get(this.db)?.get(row.id) : undefined
    return known ?? this.remember(decodeContextTransferRow(row))
  }

  private remember<T extends ContextTransferRecord>(record: T): T {
    let rows = decoded.get(this.db)
    if (!rows) {
      rows = new Map()
      decoded.set(this.db, rows)
    }
    rows.set(record.id, record)
    return record
  }
}

/** A decoded row that disagrees with the key that selected it is unreadable data. */
function agrees(value: boolean): true {
  return value || unreadableContextTransfer()
}
