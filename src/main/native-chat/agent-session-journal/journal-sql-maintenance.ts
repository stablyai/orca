import type Database from '../../sqlite/sync-database'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage,
  journalDomainImportState,
  type JournalDomainImportState
} from './journal-domain-import-rows'
import {
  completeJournalDomainCompaction,
  journalDomainCompactionState,
  pruneJournalDomainRetiredPage,
  reclaimJournalDomainPage,
  type JournalDomainMaintenance,
  type JournalDomainMaintenanceResult
} from './journal-domain-maintenance'
import { pruneJournalSqlEventTail, type JournalSqlEventTailResult } from './journal-sql-event-tail'

export type JournalSqlMaintenance =
  | { kind: 'projection-state'; sessionId: string }
  | {
      kind: 'import-page'
      target: Pick<JournalDomainImportHeader, 'sessionId' | 'epoch'>
      page: JournalDomainImportPage
    }
  | { kind: 'import-finish'; header: JournalDomainImportHeader }
  | JournalDomainMaintenance
  | { kind: 'event-tail-prune'; now: number }

export type JournalSqlProjectionState = JournalDomainImportState

export type JournalSqlMaintenanceResult =
  | JournalSqlProjectionState
  | JournalSqlEventTailResult
  | JournalDomainMaintenanceResult
  | boolean
  | string
  | null

export function applyJournalSqlMaintenance(
  db: Database.Database,
  operation: JournalSqlMaintenance
): JournalSqlMaintenanceResult {
  switch (operation.kind) {
    case 'projection-state':
      return journalDomainImportState(db, operation.sessionId)
    case 'import-page':
      return insertJournalDomainImportPage(db, operation.target, operation.page)
    case 'import-finish':
      return finishJournalDomainImport(db, operation.header)
    case 'domain-retired-prune':
      return pruneJournalDomainRetiredPage(db)
    case 'page-reclaim':
      return reclaimJournalDomainPage(db)
    case 'compaction-state':
      return journalDomainCompactionState(db)
    case 'compaction-complete':
      return completeJournalDomainCompaction(db, operation.now)
    case 'event-tail-prune':
      return pruneJournalSqlEventTail(db, operation.now)
  }
}
