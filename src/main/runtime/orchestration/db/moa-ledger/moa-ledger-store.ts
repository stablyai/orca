import { createHash } from 'node:crypto'
import type { MessageRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

// ── MoA deliberation ledger ──
// Append-only audit rows for Mixture-of-Agents deliberations. Enums are
// validated here, not with SQL CHECKs (SQLite cannot ALTER a CHECK), and entry
// ids are content-addressed so INSERT OR IGNORE makes every ingest idempotent.

export const MOA_ENTRY_KINDS = ['proposal', 'verdict', 'outcome', 'close', 'note'] as const
export type MoaEntryKind = (typeof MOA_ENTRY_KINDS)[number]

export const MOA_VERDICTS = ['support', 'challenge', 'merge', 'adopted', 'rejected'] as const
export type MoaVerdict = (typeof MOA_VERDICTS)[number]

export type MoaDeliberationRow = {
  id: string
  run_id: string
  task_id: string | null
  seat_count: number
  created_at: string
}

export type MoaLedgerEntryRow = {
  id: string
  deliberation_id: string
  round: number
  entry_kind: MoaEntryKind
  seat_id: string | null
  subject_entry_id: string | null
  verdict: MoaVerdict | null
  rationale: string | null
  payload: string
  message_id: string | null
  authored_at: string | null
  recorded_at: string
  recorded_seq: number
}

export type MoaEntryInput = {
  round?: number
  kind: string
  seat?: string
  subjectEntryId?: string
  verdict?: string
  rationale?: string
  payload?: string
  authoredAt?: string
}

function assertValidEntry(entry: MoaEntryInput): void {
  if (!(MOA_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Invalid MoA entry kind '${entry.kind}'; expected one of ${MOA_ENTRY_KINDS.join(', ')}.`
    )
  }
  if (entry.verdict !== undefined && !(MOA_VERDICTS as readonly string[]).includes(entry.verdict)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Invalid MoA verdict '${entry.verdict}'; expected one of ${MOA_VERDICTS.join(', ')}.`
    )
  }
  if (entry.payload !== undefined) {
    try {
      JSON.parse(entry.payload)
    } catch {
      throw new OrchestrationError('invalid_argument', 'MoA entry payload must be valid JSON.')
    }
  }
  if (entry.round !== undefined && (!Number.isInteger(entry.round) || entry.round < 1)) {
    throw new OrchestrationError('invalid_argument', 'MoA entry round must be a positive integer.')
  }
}

// Why content-addressed: re-sent messages and replayed relays re-derive the same id, so
// duplicates die on INSERT OR IGNORE instead of needing dedup queries.
function moaEntryId(deliberationId: string, entry: MoaEntryInput): string {
  const canonical = JSON.stringify([
    deliberationId,
    entry.round ?? 1,
    entry.kind,
    entry.seat ?? null,
    entry.subjectEntryId ?? null,
    entry.verdict ?? null,
    entry.rationale ?? null,
    entry.payload ?? '{}',
    entry.authoredAt ?? null
  ])
  return `moae_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

export function openMoaDeliberation(
  this: OrchestrationDb,
  input: { id: string; runId: string; taskId?: string; seatCount?: number }
): MoaDeliberationRow {
  this.requireRun(input.runId)
  this.db
    .prepare(
      'INSERT OR IGNORE INTO moa_deliberations (id, run_id, task_id, seat_count) VALUES (?, ?, ?, ?)'
    )
    .run(input.id, input.runId, input.taskId ?? null, input.seatCount ?? 0)
  const row = this.db
    .prepare('SELECT * FROM moa_deliberations WHERE id = ?')
    .get(input.id) as MoaDeliberationRow
  if (row.run_id !== input.runId) {
    throw new OrchestrationError(
      'invalid_argument',
      `MoA deliberation ${input.id} belongs to another Run.`
    )
  }
  return row
}

export function logMoaEntries(
  this: OrchestrationDb,
  input: {
    runId: string
    deliberationId: string
    taskId?: string
    seatCount?: number
    entries: MoaEntryInput[]
    messageId?: string
  }
): { deliberation: MoaDeliberationRow; inserted: number; duplicates: number } {
  for (const entry of input.entries) {
    assertValidEntry(entry)
  }
  this.db.exec('SAVEPOINT moa_log_entries')
  try {
    const deliberation = this.openMoaDeliberation({
      id: input.deliberationId,
      runId: input.runId,
      taskId: input.taskId,
      seatCount: input.seatCount
    })
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO moa_ledger_entries (
        id, deliberation_id, round, entry_kind, seat_id, subject_entry_id,
        verdict, rationale, payload, message_id, authored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    for (const entry of input.entries) {
      const result = stmt.run(
        moaEntryId(deliberation.id, entry),
        deliberation.id,
        entry.round ?? 1,
        entry.kind,
        entry.seat ?? null,
        entry.subjectEntryId ?? null,
        entry.verdict ?? null,
        entry.rationale ?? null,
        entry.payload ?? '{}',
        input.messageId ?? null,
        entry.authoredAt ?? null
      )
      inserted += Number(result.changes)
    }
    this.db.exec('RELEASE moa_log_entries')
    return { deliberation, inserted, duplicates: input.entries.length - inserted }
  } catch (error) {
    this.db.exec('ROLLBACK TO moa_log_entries')
    this.db.exec('RELEASE moa_log_entries')
    throw error
  }
}

// Transport-tolerant materializer: a status message may carry payload.moa from a
// newer or foreign client. Malformed payloads must never fail message delivery,
// so this validates quietly and records nothing on shape errors; the explicit
// orchestration.moaLog RPC is the strict path.
export function ingestMoaMessagePayload(this: OrchestrationDb, message: MessageRow): number {
  if (message.type !== 'status' || !message.payload || !message.payload.includes('"moa"')) {
    return 0
  }
  let moa: {
    deliberation?: unknown
    taskId?: unknown
    seatCount?: unknown
    entries?: unknown
  } | null = null
  try {
    const parsed = JSON.parse(message.payload) as { moa?: typeof moa }
    moa = parsed?.moa ?? null
  } catch {
    return 0
  }
  if (!moa || typeof moa.deliberation !== 'string' || !Array.isArray(moa.entries)) {
    return 0
  }
  const entries: MoaEntryInput[] = []
  for (const raw of moa.entries) {
    const entry = raw as MoaEntryInput
    try {
      assertValidEntry(entry)
    } catch {
      return 0
    }
    entries.push(entry)
  }
  if (entries.length === 0) {
    return 0
  }
  try {
    const result = this.logMoaEntries({
      runId: message.run_id,
      deliberationId: moa.deliberation,
      taskId: typeof moa.taskId === 'string' ? moa.taskId : undefined,
      seatCount: typeof moa.seatCount === 'number' ? moa.seatCount : undefined,
      entries,
      messageId: message.id
    })
    return result.inserted
  } catch {
    return 0
  }
}

export function getMoaDeliberation(
  this: OrchestrationDb,
  id: string
): MoaDeliberationRow | undefined {
  return this.db.prepare('SELECT * FROM moa_deliberations WHERE id = ?').get(id) as
    | MoaDeliberationRow
    | undefined
}

export function listMoaDeliberations(
  this: OrchestrationDb,
  filter: { runId: string }
): MoaDeliberationRow[] {
  return this.db
    .prepare('SELECT * FROM moa_deliberations WHERE run_id = ? ORDER BY created_at, id')
    .all(filter.runId) as MoaDeliberationRow[]
}

export function listMoaEntries(
  this: OrchestrationDb,
  filter: { deliberationId: string; round?: number }
): MoaLedgerEntryRow[] {
  // Why (round, authored_at, id) and not insertion order: federated entries land in
  // relay-arrival order, so rowid would misreport who spoke first.
  if (filter.round !== undefined) {
    return this.db
      .prepare(
        `SELECT *, rowid AS recorded_seq FROM moa_ledger_entries
         WHERE deliberation_id = ? AND round = ?
         ORDER BY round, authored_at, id`
      )
      .all(filter.deliberationId, filter.round) as MoaLedgerEntryRow[]
  }
  return this.db
    .prepare(
      `SELECT *, rowid AS recorded_seq FROM moa_ledger_entries
       WHERE deliberation_id = ?
       ORDER BY round, authored_at, id`
    )
    .all(filter.deliberationId) as MoaLedgerEntryRow[]
}

export type MoaLedgerStoreMethods = {
  openMoaDeliberation: typeof openMoaDeliberation
  logMoaEntries: typeof logMoaEntries
  ingestMoaMessagePayload: typeof ingestMoaMessagePayload
  getMoaDeliberation: typeof getMoaDeliberation
  listMoaDeliberations: typeof listMoaDeliberations
  listMoaEntries: typeof listMoaEntries
}

export function attachMoaLedgerStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    openMoaDeliberation,
    logMoaEntries,
    ingestMoaMessagePayload,
    getMoaDeliberation,
    listMoaDeliberations,
    listMoaEntries
  })
}
