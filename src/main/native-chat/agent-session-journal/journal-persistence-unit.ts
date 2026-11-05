import type { JournalMaintenanceUnit } from './journal-maintenance-unit'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { journalPragmaNumber } from './journal-database'
import { admitsJournalOutcome } from './journal-maintenance-unit'
import type Database from '../../sqlite/sync-database'
import type { JournalPersistenceEffect, JournalEffectResult } from './journal-persistence-plan'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from '../../runtime/agent-session/records/agent-session-record-rows'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'
import { CommandReceiptExistsError } from './command-receipt-transaction'
import {
  markUnclaimedUploadForSweep,
  finishUploadSweep,
  claimPreparedAgentSessionAttachments
} from '../agent-session-attachments/agent-session-attachment-claims'
import {
  journalOutcomeSource,
  startJournalOutcomeLog,
  advanceJournalOutcomeSource
} from './journal-outcome-format'
import {
  readJournalSessionEpoch,
  deleteJournalEpochRows,
  publishJournalSessionEpoch
} from './journal-row-table'
import { writeJournalEncodedOutcomes } from './journal-outcome-persistence'
import { AgentSessionJournalError } from './journal-write-guards'

/** Result-dependent SQL stays on the native owner, including earlier writes in this same unit. */
export function applyJournalPersistenceEffect(
  db: Database.Database,
  effect: JournalPersistenceEffect
): JournalEffectResult {
  switch (effect.kind) {
    case 'rows': {
      const insert = db.prepare(
        'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
      )
      for (const row of effect.rows) {
        insert.run(effect.sessionId, row.epoch, row.seq, row.savedAt, row.json)
      }
      return null
    }
    case 'queue-delete': {
      const remove = db.prepare(
        'DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?'
      )
      for (const id of effect.ids) {
        remove.run(effect.sessionId, id)
      }
      return null
    }
    case 'store': {
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
      return null
    }
    case 'receipt': {
      const result = insertCommandReceiptIfAbsent(db, effect.scope, effect.receipt)
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
      return null
    }
    case 'claim':
      return claimPreparedAgentSessionAttachments(db, effect.claim)
    case 'sweep': {
      const op = effect.operation
      if (op.kind === 'mark') {
        return markUnclaimedUploadForSweep(db, op.uploadId, op.now)
      }
      if (op.kind === 'finish') {
        finishUploadSweep(db, op.uploadId)
        return null
      }
      const remove = db.prepare(
        'DELETE FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
      )
      let removed = 0
      for (const pair of op.pairs) {
        removed += Number(remove.run(pair.uploadId, pair.sessionId).changes)
      }
      return removed
    }
    case 'epoch': {
      const retired = readJournalSessionEpoch(db, effect.sessionId)
      if (effect.expected !== undefined && retired !== effect.expected) {
        throw new AgentSessionJournalError('journal_row_rejected', 'the chat epoch changed')
      }
      if (retired !== null) {
        journalOutcomeSource(db, effect.sessionId, retired)
        deleteJournalEpochRows(db, effect.sessionId, retired)
      }
      publishJournalSessionEpoch(db, effect, effect.epoch)
      return null
    }
    case 'outcomes': {
      const previous = journalOutcomeSource(db, effect.sessionId, effect.epoch)
      const source =
        previous ??
        startJournalOutcomeLog(db, effect.sessionId, effect.epoch, effect.expected, effect.savedAt)
      if (source.through !== effect.expected) {
        throw new Error('journal outcome writer has stale coverage')
      }
      writeJournalEncodedOutcomes(db, source, effect.values)
      advanceJournalOutcomeSource(db, effect.sessionId, effect.epoch, effect.through)
      return null
    }
  }
}

/** Guard every candidate against current metadata; scans never authorize deletion by themselves. */
export function applyJournalMaintenance(
  db: Database.Database,
  unit: JournalMaintenanceUnit,
  timing = { started: performance.now(), now: () => performance.now() }
): { more: boolean; valid: boolean; steps: number } {
  if (unit.kind === 'vacuum') {
    let before = journalPragmaNumber(db, 'freelist_count')
    if (journalPragmaNumber(db, 'auto_vacuum') !== 2 || before === 0) {
      return { more: false, valid: true, steps: 0 }
    }
    let steps = 0
    const limit = Math.min(32, unit.pages)
    while (steps < limit && (steps === 0 || timing.now() - timing.started < 8)) {
      db.pragma('incremental_vacuum(1)')
      steps++
      const after = journalPragmaNumber(db, 'freelist_count')
      if (after === 0 || after >= before) {
        return { more: false, valid: true, steps }
      }
      before = after
    }
    return { more: before > 0, valid: true, steps }
  }
  if (unit.kind === 'retired') {
    const identity = db
      .prepare('SELECT session_id, epoch FROM journal_outcome_generations WHERE generation = ?')
      .get(unit.generation)
    if (typeof identity?.session_id !== 'string' || typeof identity.epoch !== 'string') {
      return { more: false, valid: false, steps: 0 }
    }
    const current = db
      .prepare('SELECT epoch, generation FROM journal_outcome_epochs WHERE session_id = ?')
      .get(identity.session_id)
    if (
      current &&
      (typeof current.epoch !== 'string' ||
        typeof current.generation !== 'number' ||
        current.epoch === identity.epoch ||
        current.generation === unit.generation)
    ) {
      return { more: false, valid: false, steps: 0 }
    }
    const remove = db.prepare('DELETE FROM journal_outcomes WHERE generation = ? AND rowid = ?')
    for (const row of unit.rows) {
      remove.run(unit.generation, row.rowid)
    }
    const more =
      db
        .prepare('SELECT 1 FROM journal_outcomes WHERE generation = ? LIMIT 1')
        .get(unit.generation) !== undefined
    if (!more) {
      db.prepare('DELETE FROM journal_outcome_generations WHERE generation = ?').run(
        unit.generation
      )
    }
    return { more, valid: true, steps: 0 }
  }
  const { active } = unit
  let source
  try {
    source = journalOutcomeSource(db, active.sessionId, active.epoch)
  } catch (error) {
    if (
      error instanceof JournalOutcomeDecodeError ||
      (error instanceof AgentSessionJournalError &&
        (error.code === 'journal_read_only' || error.code === 'journal_row_rejected'))
    ) {
      return { more: false, valid: false, steps: 0 }
    }
    throw error
  }
  if (
    source?.generation !== active.generation ||
    !admitsJournalOutcome(source.format, 'items', '') ||
    source.prefix !== active.prefix ||
    source.through < active.through
  ) {
    return { more: false, valid: false, steps: 0 }
  }
  const first = db.prepare(
    'SELECT seq FROM journal_outcomes WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq LIMIT 1'
  )
  const latest = db.prepare(
    'SELECT seq FROM journal_outcomes WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1'
  )
  const remove = db.prepare(
    'DELETE FROM journal_outcomes WHERE generation = ? AND seq = ? AND field = ? AND entry_key = ? AND format = ? AND deleted = 0'
  )
  for (const row of unit.rows) {
    if (!admitsJournalOutcome(row.format, row.field, row.key)) {
      return { more: false, valid: false, steps: 0 }
    }
    if (row.deleted !== 0 || row.field === 'tombstones' || row.field === 'removedTurnIds') {
      continue
    }
    const key = [active.generation, row.field, row.key]
    // Whole-value replacement makes superseded middle records redundant; changing it needs a format bump.
    if (row.seq !== first.get(...key)?.seq && row.seq !== latest.get(...key)?.seq) {
      remove.run(active.generation, row.seq, row.field, row.key, row.format)
    }
  }
  return { more: true, valid: true, steps: 0 }
}
