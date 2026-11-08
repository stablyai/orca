import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import { runningTurnLifecycleRevisions } from '../agent-session-wire/termination/structured-agent-session-stale-turn-verdict'
import { applyJournalDomainLifecycle } from './journal-domain-lifecycle'

import type { JournalWriterOperation } from './journal-writer-command'

export function applyJournalDomainLifecycleOperation(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  operation: Extract<JournalWriterOperation, { kind: 'lifecycle' }>,
  savedAt: number,
  stopSettle?: JournalStopSettleFact
) {
  if (operation.takenStop) {
    const result = applyJournalDomainTakenStop(
      db,
      target,
      operation.input,
      operation.takenStop,
      savedAt,
      stopSettle
    )
    return { ...result, value: result.opened }
  }
  const result = applyJournalDomainLifecycle(db, target, operation.input, savedAt, stopSettle)
  return { ...result, value: result.cursor }
}

/** Select the exact turn's running records at the lifecycle command's writer position. */
function applyJournalDomainTakenStop(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalLifecycleBatchInput,
  takenStop: { turnId: string; completedAt: number },
  savedAt: number,
  stopSettle?: JournalStopSettleFact
) {
  const prefix = [target.sessionId, target.epoch, takenStop.turnId] as const
  const opened =
    db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_named_turn
    WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0 LIMIT 1`)
      .get(...prefix) !== undefined
  const items = db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_named_turn
    WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0 AND lifecycle_state='running'
    ORDER BY sequence,sequence_index,ordinal`)
    .all(...prefix)
    .map((row): AgentJournalRenderItem => JSON.parse(String(row.payload_json)))
  const result = applyJournalDomainLifecycle(
    db,
    target,
    {
      ...input,
      mutations: runningTurnLifecycleRevisions(items, {
        state: 'interrupted',
        completedAt: takenStop.completedAt
      })
    },
    savedAt,
    stopSettle
  )
  return { ...result, opened }
}
