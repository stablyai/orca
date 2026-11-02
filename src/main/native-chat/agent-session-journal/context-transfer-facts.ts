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

// Each keyed query below uses exactly these expressions so SQLite picks the matching index.
export const CONTEXT_TRANSFER_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_kind
  ON agent_session_context_transfers(session_id, kind);
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_format
  ON agent_session_context_transfers(session_id, format);
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_delivery_target
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.targetId'), json_extract(record_json, '$.outcome.kind'))
  WHERE kind = 'delivery';
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_delivery_carrier
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.carrierInputId'))
  WHERE kind = 'delivery';
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_closure_command
  ON agent_session_context_transfers(session_id, json_extract(record_json, '$.commandId'))
  WHERE kind = 'closure';
`

const COLUMNS = 'id, session_id, handoff_id, kind, format, record_json'
const TABLE = 'agent_session_context_transfers'

/** Every keyed read; each must plan as an index search, never a scan of the chat's rows. */
export const CONTEXT_TRANSFER_KEYED_SQL = {
  foreignFormat: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND (format < 1 OR format > 1) LIMIT 1`,
  any: `SELECT 1 FROM ${TABLE} WHERE session_id = ? LIMIT 1`,
  byId: `SELECT ${COLUMNS} FROM ${TABLE} WHERE id = ?`,
  newestTarget: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'target' ORDER BY rowid DESC LIMIT 1`,
  closed: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND handoff_id = ? AND kind = 'closure' LIMIT 1`,
  delivered: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND kind = 'delivery' AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') IN ('injected', 'inline-accepted', 'not-required') LIMIT 1`,
  startedWithoutOutcome: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND kind = 'delivery' AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') IS NULL AND json_extract(record_json, '$.writeStartedAt') IS NOT NULL LIMIT 1`,
  startedUnknown: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND kind = 'delivery' AND json_extract(record_json, '$.targetId') = ? AND json_extract(record_json, '$.outcome.kind') = 'unknown' AND json_extract(record_json, '$.writeStartedAt') IS NOT NULL LIMIT 1`,
  carriers: `SELECT ${COLUMNS} FROM ${TABLE} WHERE session_id = ? AND kind = 'delivery' AND json_extract(record_json, '$.carrierInputId') = ? ORDER BY rowid`,
  closedByCommand: `SELECT 1 FROM ${TABLE} WHERE session_id = ? AND kind = 'closure' AND json_extract(record_json, '$.commandId') = ? LIMIT 1`,
  newestClosure: `SELECT rowid AS at FROM ${TABLE} WHERE session_id = ? AND kind = 'closure' ORDER BY rowid DESC LIMIT 1`,
  handoffsAfter: `SELECT id FROM ${TABLE} WHERE session_id = ? AND kind = 'handoff' AND rowid > ? ORDER BY rowid`
} as const
const SQL = CONTEXT_TRANSFER_KEYED_SQL

export function unreadableContextTransfer(): never {
  throw journalOpenRefusalError(
    new AgentSessionJournalError(
      'journal_read_only',
      'Saved context transfer cannot be read by this Orca'
    )
  )
}

/** A row's bytes are this build's format and say what its columns say, or the chat refuses. */
export function decodeContextTransferRow(row: Record<string, unknown>): ContextTransferRecord {
  if (row.format !== 1 || typeof row.record_json !== 'string') {
    return unreadableContextTransfer()
  }
  let value: unknown
  try {
    value = JSON.parse(row.record_json)
  } catch {
    return unreadableContextTransfer()
  }
  const decoded = contextTransferRecordSchema.safeParse(value)
  if (!decoded.success) {
    return unreadableContextTransfer()
  }
  const record = decoded.data
  if (
    record.id !== row.id ||
    record.sessionId !== row.session_id ||
    record.handoffId !== row.handoff_id ||
    record.kind !== row.kind
  ) {
    return unreadableContextTransfer()
  }
  return record
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

// Decoded rows and format checks live only until the transaction that may change them ends, or a write replaces them.
const decoded = new WeakMap<
  Database.Database,
  { rows: Map<string, ContextTransferRecord>; formatChecked: Set<string> }
>()

function memo(db: Database.Database) {
  let value = decoded.get(db)
  if (!value) {
    value = { rows: new Map(), formatChecked: new Set() }
    decoded.set(db, value)
  }
  return value
}

export function forgetContextTransferRows(db: Database.Database): void {
  decoded.delete(db)
}

export function forgetContextTransferRow(db: Database.Database, id: string): void {
  decoded.get(db)?.rows.delete(id)
}

/** Keyed reads of one chat's transfer facts; SQL on this connection is the only authority. */
export class ContextTransferFacts {
  constructor(
    private readonly db: Database.Database,
    readonly sessionId: string
  ) {}

  /** A row in a format this build doesn't write refuses the chat rather than being skipped. */
  checkFormat(): void {
    const checked = memo(this.db).formatChecked
    if (checked.has(this.sessionId)) {
      return
    }
    const foreign = this.db.prepare(SQL.foreignFormat).get(this.sessionId)
    if (foreign) {
      unreadableContextTransfer()
    }
    checked.add(this.sessionId)
  }

  any(): boolean {
    this.checkFormat()
    return this.db.prepare(SQL.any).get(this.sessionId) !== undefined
  }

  record(id: string): ContextTransferRecord | undefined {
    this.checkFormat()
    const known = decoded.get(this.db)?.rows.get(id)
    if (known) {
      return known.sessionId === this.sessionId ? known : undefined
    }
    const row = this.db.prepare(SQL.byId).get(id)
    if (!row || row.session_id !== this.sessionId) {
      return undefined
    }
    return this.remember(decodeContextTransferRow(row))
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
    this.checkFormat()
    const row = this.db.prepare(SQL.newestTarget).get(this.sessionId)
    if (!row) {
      return undefined
    }
    const target = this.remember(decodeContextTransferRow(row))
    if (target.kind !== 'target' || this.closed(target.handoffId)) {
      return undefined
    }
    return target
  }

  closed(handoffId: string): boolean {
    return this.db.prepare(SQL.closed).get(this.sessionId, handoffId) !== undefined
  }

  delivered(targetId: string): boolean {
    this.checkFormat()
    return query(() => this.db.prepare(SQL.delivered).get(this.sessionId, targetId) !== undefined)
  }

  /** A started write with no final outcome: either no outcome yet or a recorded unknown. */
  uncertain(targetId: string): boolean {
    this.checkFormat()
    const started = (sql: string) =>
      query(() => this.db.prepare(sql).get(this.sessionId, targetId) !== undefined)
    return started(SQL.startedWithoutOutcome) || started(SQL.startedUnknown)
  }

  /** Inline deliveries this input carried that still await a final outcome. */
  carriers(inputId: string): ContextTransferDelivery[] {
    this.checkFormat()
    const rows = query(() => this.db.prepare(SQL.carriers).all(this.sessionId, inputId))
    return rows.flatMap((row) => {
      const record = this.remember(decodeContextTransferRow(row))
      return record.kind === 'delivery' &&
        record.mode === 'inline' &&
        (record.outcome === null || record.outcome.kind === 'unknown')
        ? [record]
        : []
    })
  }

  closedByCommand(commandId: string): boolean {
    this.checkFormat()
    return query(
      () => this.db.prepare(SQL.closedByCommand).get(this.sessionId, commandId) !== undefined
    )
  }

  /** Every handoff before the newest closure was closed with it, so open ones are newer. */
  openHandoffs(): string[] {
    this.checkFormat()
    const newest = this.db.prepare(SQL.newestClosure).get(this.sessionId)
    const after = typeof newest?.at === 'number' ? newest.at : 0
    return this.db
      .prepare(SQL.handoffsAfter)
      .all(this.sessionId, after)
      .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
  }

  private remember<T extends ContextTransferRecord>(record: T): T {
    memo(this.db).rows.set(record.id, record)
    return record
  }
}
