import { prepareJournalLegacyClaimsInsert } from './database/journal-legacy-claims'
import { createHash } from 'node:crypto'
import type { LegacyDestinationIdentity } from './journal-legacy-retirement-files'
import type { LegacyClaim } from './journal-legacy-content-proof'
import {
  JOURNAL_LEGACY_ORIGINAL,
  JOURNAL_LEGACY_RETIREMENT,
  type JournalLegacyRetirementState
} from './journal-legacy-retirement-state'
import { JOURNAL_LEGACY_SOURCE_RECEIPT } from './database/journal-legacy-source-receipt'
import { JOURNAL_LEGACY_REVISIONS_KEPT } from './database/journal-legacy-reconcile'
import { JOURNAL_LEGACY_CONVERTED_BY } from './database/journal-host-database'
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
import { compactJournalStoredOutputPage } from './journal-stored-output-compaction'
import { pruneJournalSqlEventTail, type JournalSqlEventTailResult } from './journal-sql-event-tail'
import {
  discardJournalDomainImportPage,
  type JournalDomainImportDiscard
} from './journal-domain-import-discard'
import { discardForgottenJournalChatPage } from './journal-forgotten-chats'
import { installAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import { storedAgentSessionBackground } from '../../runtime/agent-session/records/agent-session-tab-table'
import type { JournalSqlStoredRecords } from './journal-sql-database-read'
import { settleJournalLegacyCompare } from './database/journal-legacy-compare'
import { recordJournalLegacyCopyFailure } from './database/journal-legacy-copies'
import {
  fillJournalConnectorReplies,
  sentJournalConnectorReplies
} from './connector-replies/journal-connector-replies'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyKey
} from '../../../shared/agent-session/journal/journal-connector-reply'

/** Operations the background pass runs a bounded page at a time. */
export type JournalPagedMaintenanceKind =
  | 'event-tail-prune'
  | 'domain-retired-prune'
  | 'page-reclaim'
  | 'chat-discard'
  | 'stored-output-compaction'

export type JournalSqlMaintenance =
  | { kind: 'legacy-retirement-state' }
  | { kind: 'legacy-claims-absorb'; claims: readonly LegacyClaim[] }
  | {
      kind: 'legacy-originals-keep'
      originals: readonly { sessionId: string; value: string; identity: string }[]
    }
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
  | { kind: 'chat-discard'; sessionId: string }
  | {
      kind: 'import-page'
      target: Pick<JournalDomainImportHeader, 'sessionId' | 'epoch'>
      page: JournalDomainImportPage
    }
  | { kind: 'import-finish'; header: JournalDomainImportHeader }
  | JournalDomainMaintenance
  | { kind: 'event-tail-prune'; now: number }
  | ({ kind: 'legacy-compare-settle' } & Parameters<typeof settleJournalLegacyCompare>[1])
  | { kind: 'legacy-copy-failed'; sessionId: string; error: string }
  // The reply outbox's rows outside any chat's lane: filled with outcomes, and sent.
  | { kind: 'connector-replies-fill'; fills: readonly JournalConnectorReplyFill[]; now: number }
  | { kind: 'connector-replies-sent'; keys: readonly JournalConnectorReplyKey[]; now: number }

export type JournalSqlProjectionState = JournalDomainImportState

export type JournalSqlMaintenanceResult =
  | ({ kind: 'legacy-retirement-state' } & JournalLegacyRetirementState)
  | { kind: 'records'; records: JournalSqlStoredRecords }
  | JournalForkStageResult
  | JournalSqlProjectionState
  | JournalSqlEventTailResult
  | JournalDomainMaintenanceResult
  | JournalDomainImportDiscard
  | ReturnType<typeof discardForgottenJournalChatPage>
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
        receipt: value(JOURNAL_LEGACY_SOURCE_RECEIPT),
        kept: value(JOURNAL_LEGACY_REVISIONS_KEPT) !== null,
        convertedBy: value(JOURNAL_LEGACY_CONVERTED_BY),
        retirement: value(JOURNAL_LEGACY_RETIREMENT)
      }
    }
    case 'legacy-claims-absorb': {
      // Keeps the uploads an original claimed for chats this store keeps before it retires.
      const insert = prepareJournalLegacyClaimsInsert(db)
      for (const claim of operation.claims) {
        insert.run(claim.uploadId, claim.sessionId, claim.claimedAt)
      }
      return true
    }
    case 'legacy-originals-keep': {
      // What only the original holds for a chat both sides changed, kept verbatim before it goes.
      // Keyed by what a person made in it too, so an original retired later never replaces one kept
      // before, and one differing only in bookkeeping adds nothing.
      const keep = db.prepare(
        'INSERT OR IGNORE INTO agent_session_store_meta(key,value) VALUES(?,?)'
      )
      for (const { sessionId, value, identity } of operation.originals) {
        const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16)
        keep.run(`${JOURNAL_LEGACY_ORIGINAL}${sessionId}:${digest}`, value)
      }
      return true
    }
    case 'legacy-retirement-save':
      db.prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)').run(
        JOURNAL_LEGACY_RETIREMENT,
        operation.value
      )
      return true

    case 'wsl-workspace-rekey':
      return rekeyWslDriveUncChats(db, operation.worktreeIds)
    case 'records-install': {
      const records = installAgentSessionStoreRows(db)
      return {
        kind: 'records',
        records: {
          ...records,
          sessionTabs: records.sessionTabs?.entries() ?? null,
          backgroundSessions: storedAgentSessionBackground(records.sessionTabs)
        }
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
    case 'chat-discard':
      return discardForgottenJournalChatPage(db, operation.sessionId)
    case 'connector-replies-fill':
      return fillJournalConnectorReplies(db, operation.fills, operation.now) > 0
    case 'connector-replies-sent':
      sentJournalConnectorReplies(db, operation.keys, operation.now)
      return true
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
    case 'legacy-compare-settle':
      settleJournalLegacyCompare(db, operation)
      return null
    case 'legacy-copy-failed':
      recordJournalLegacyCopyFailure(db, operation.sessionId, operation.error)
      return null
    case 'stored-output-compaction':
      return compactJournalStoredOutputPage(db)
  }
}
