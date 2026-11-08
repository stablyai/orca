import type Database from '../../sqlite/sync-database'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage,
  journalDomainImportState,
  type JournalDomainImportState
} from './journal-domain-import-rows'
import { sweepJournalSqlProjectionPage } from './journal-sql-projection-sweep'
import { pruneJournalSqlEventTail, type JournalSqlEventTailResult } from './journal-sql-event-tail'

export type JournalSqlMaintenance =
  | { kind: 'projection-state'; sessionId: string }
  | {
      kind: 'import-page'
      target: Pick<JournalDomainImportHeader, 'sessionId' | 'epoch'>
      page: JournalDomainImportPage
    }
  | { kind: 'import-finish'; header: JournalDomainImportHeader }
  | { kind: 'projection-sweep' }
  | { kind: 'event-tail-prune'; now: number }

export type JournalSqlProjectionState = JournalDomainImportState

export type JournalSqlMaintenanceResult =
  | JournalSqlProjectionState
  | JournalSqlEventTailResult
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
    case 'projection-sweep':
      return sweepJournalSqlProjectionPage(db)
    case 'event-tail-prune':
      return pruneJournalSqlEventTail(db, operation.now)
  }
}
