import type { LegacyDestinationIdentity } from './journal-legacy-retirement-files'
import { rekeyWslDriveUncChats } from '../../wsl/filesystem/wsl-drive-unc-chat-rekey'
import type { JournalForkStageOperation, JournalForkStageResult } from './journal-fork-stages'
import { saveJournalDomainOutlineCache, type JournalOutlineCache } from './journal-domain-outline'
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
import {
  discardJournalDomainImportPage,
  type JournalDomainImportDiscard
} from './journal-domain-import-discard'
import { installAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type { JournalSqlStoredRecords } from './journal-sql-database-read'

export type JournalSqlMaintenance =
  | { kind: 'legacy-retirement-state' }
  | {
      kind: 'legacy-retirement-save'
      value: string
      durable: boolean
      destination?: LegacyDestinationIdentity
    }
  | { kind: 'records-install' }
  | { kind: 'wsl-workspace-rekey'; worktreeIds: readonly (readonly [string, string])[] }
  | JournalForkStageOperation
  | { kind: 'outline-cache'; cache: JournalOutlineCache }
  | { kind: 'projection-state'; sessionId: string }
  | { kind: 'import-discard'; sessionId: string }
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
  | { kind: 'legacy-retirement-state'; receipt: string | null; retirement: string | null }
  | { kind: 'records'; records: JournalSqlStoredRecords }
  | JournalForkStageResult
  | JournalSqlProjectionState
  | JournalSqlEventTailResult
  | JournalDomainMaintenanceResult
  | JournalDomainImportDiscard
  | boolean
  | string
  | null

export function applyJournalSqlMaintenance(
  db: Database.Database,
  operation: JournalSqlMaintenance
): JournalSqlMaintenanceResult {
  switch (operation.kind) {
    case 'legacy-retirement-state': {
      const value = (key: string) =>
        db
          .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
          .get(key)
          ?.value?.toString() ?? null
      return {
        kind: 'legacy-retirement-state',
        receipt: value('journal.legacy-source-copy.v1'),
        retirement: value('journal.legacy-retirement.v1')
      }
    }
    case 'legacy-retirement-save':
      db.prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)').run(
        'journal.legacy-retirement.v1',
        operation.value
      )
      return true

    case 'wsl-workspace-rekey':
      return rekeyWslDriveUncChats(db, operation.worktreeIds)
    case 'records-install': {
      const records = installAgentSessionStoreRows(db)
      return {
        kind: 'records',
        records: { ...records, sessionTabs: records.sessionTabs?.entries() ?? null }
      }
    }
    case 'fork-source-hold':
    case 'fork-source-release':
    case 'fork-stage-begin':
    case 'fork-stage-page':
    case 'fork-abort':
      throw new Error('fork staging requires its live writer owner')
    case 'outline-cache':
      return saveJournalDomainOutlineCache(db, operation.cache)
    case 'projection-state':
      return journalDomainImportState(db, operation.sessionId)
    case 'import-discard':
      return discardJournalDomainImportPage(db, operation.sessionId)
    case 'import-page':
      return insertJournalDomainImportPage(db, operation.target, operation.page)
    case 'import-finish':
      return finishJournalDomainImport(db, operation.header)
    case 'domain-retired-prune':
      return pruneJournalDomainRetiredPage(db, operation)
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
