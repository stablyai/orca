import type Database from '../../sqlite/sync-database'
import {
  beginJournalSqlConversion,
  currentJournalSqlEpoch,
  journalLogNeedsFounding,
  type JournalLogWatermark
} from './journal-sql-meta'
import {
  finishJournalSqlConversion,
  insertJournalSqlConversionRows,
  type JournalSqlConversionTable
} from './journal-sql-conversion'
import {
  deleteJournalSqlProjectionPage,
  sweepJournalSqlProjectionPage
} from './journal-sql-projection-sweep'
import { pruneJournalSqlEventTail, type JournalSqlEventTailResult } from './journal-sql-event-tail'

export type JournalSqlMaintenance =
  | { kind: 'projection-state'; sessionId: string }
  | { kind: 'conversion-begin'; sessionId: string }
  | { kind: 'conversion-clear'; sessionId: string }
  | {
      kind: 'conversion-insert'
      table: Pick<JournalSqlConversionTable, 'name' | 'columns'>
      rows: unknown[][]
    }
  | { kind: 'conversion-finish'; sessionId: string; watermark: JournalLogWatermark }
  | { kind: 'projection-sweep' }
  | { kind: 'event-tail-prune'; now: number }

export type JournalSqlProjectionState =
  | { state: 'founding' | 'converting'; epoch: null }
  | { state: 'ready'; epoch: string }

export type JournalSqlMaintenanceResult =
  | JournalSqlProjectionState
  | JournalSqlEventTailResult
  | boolean
  | null

/** Each call is one writer batch; only the final publication needs FULL durability. */
export function journalSqlMaintenanceIsNormal(operation: JournalSqlMaintenance): boolean {
  return operation.kind !== 'conversion-finish' && operation.kind !== 'projection-state'
}

export function applyJournalSqlMaintenance(
  db: Database.Database,
  operation: JournalSqlMaintenance
): JournalSqlMaintenanceResult {
  switch (operation.kind) {
    case 'projection-state': {
      if (journalLogNeedsFounding(db, operation.sessionId)) {
        return { state: 'founding', epoch: null }
      }
      const epoch = currentJournalSqlEpoch(db, operation.sessionId)
      return epoch === null ? { state: 'converting', epoch } : { state: 'ready', epoch }
    }
    case 'conversion-begin':
      beginJournalSqlConversion(db, operation.sessionId)
      return null
    case 'conversion-clear':
      return deleteJournalSqlProjectionPage(db, operation.sessionId, null, 512)
    case 'conversion-insert':
      insertJournalSqlConversionRows(db, operation.table, operation.rows)
      return null
    case 'conversion-finish':
      return finishJournalSqlConversion(db, operation)
    case 'projection-sweep':
      return sweepJournalSqlProjectionPage(db)
    case 'event-tail-prune':
      return pruneJournalSqlEventTail(db, operation.now)
  }
}
