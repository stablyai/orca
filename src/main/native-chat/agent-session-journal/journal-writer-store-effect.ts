import type Database from '../../sqlite/sync-database'
import { writeAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type {
  JournalWriterEffect,
  JournalWriterStoreResult,
  JournalWriterCoordinate
} from './journal-writer-effects'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { resolveJournalWriterStoreMutation } from './journal-writer-store-mutation'

export function applyJournalWriterStoreEffect(
  db: Database.Database,
  effect: Extract<JournalWriterEffect, { kind: 'store' }>,
  rows: readonly (JournalRow | JournalWriterCoordinate)[] = []
): JournalWriterStoreResult {
  const resolved = resolveJournalWriterStoreMutation(
    db,
    effect.mutation.input,
    effect.mutation.at,
    rows
      .flatMap((row) =>
        'planApprovalMode' in row && row.planApprovalMode ? [row.planApprovalMode] : []
      )
      .at(-1),
    effect.mutation.runtime
  )
  writeAgentSessionStoreRows(db, resolved.writes)
  return {
    kind: 'store',
    disposition: resolved.changed ? 'applied' : 'noop',
    writes: resolved.acknowledged,
    value: resolved.value
  }
}
