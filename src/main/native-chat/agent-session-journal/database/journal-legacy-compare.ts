import type Database from '../../../sqlite/sync-database'
import { prepareJournalDomainImport, type JournalDomainImportPage } from '../journal-domain-import'
import { journalLegacyChatRevision, recordJournalLegacyChatRevision } from './journal-legacy-source'
import {
  deleteMeta,
  JOURNAL_LEGACY_COMPARE,
  JOURNAL_LEGACY_COPY_DUE,
  prefixEnd,
  readMeta,
  recordJournalLegacyFailure,
  writeMeta
} from './journal-legacy-reconcile-marks'

export type JournalLegacyCompare = { sessionId: string; revision: string }

/** Converted chats awaiting a background compare, in pages after `after`. */
export function pendingJournalLegacyCompares(
  db: Database.Database,
  after: string | null
): JournalLegacyCompare[] {
  return db
    .prepare(`SELECT key,value FROM agent_session_store_meta WHERE key>? AND key<?
      ORDER BY key LIMIT 16`)
    .all(`${JOURNAL_LEGACY_COMPARE}${after ?? ''}`, prefixEnd(JOURNAL_LEGACY_COMPARE))
    .map((row) => ({
      sessionId: String(row.key).slice(JOURNAL_LEGACY_COMPARE.length),
      revision: String(row.value)
    }))
}

/** The most original rows one background step restores to compare. */
const JOURNAL_LEGACY_COMPARE_ROWS = 20_000

/**
 * Whether this file already holds every item of the original chat. Runs on a reader, one chat at
 * a time, and stops at the first item this chat never held.
 */
export function compareJournalLegacyChat(
  source: Database.Database,
  db: Database.Database,
  sessionId: string
): { revision: string; held: boolean } {
  // Too long to restore in one bounded step: keep its turns as a copy rather than compare.
  if (
    source
      .prepare(`SELECT 1 FROM journal_rows WHERE session_id=?1
        AND epoch=(SELECT epoch FROM journal_sessions WHERE session_id=?1) LIMIT 1 OFFSET ?2`)
      .get(sessionId, JOURNAL_LEGACY_COMPARE_ROWS)
  ) {
    return { revision: journalLegacyChatRevision(source, sessionId) ?? 'null', held: false }
  }
  const imported = prepareJournalDomainImport(source, sessionId)
  if (!imported) {
    return { revision: journalLegacyChatRevision(source, sessionId) ?? 'null', held: true }
  }
  return {
    revision: imported.sourceRevision ?? 'null',
    held: heldEveryItem(db, sessionId, imported.pages)
  }
}

/** Ignored when a later open marked a newer revision; a failed compare is absorbed like a chat. */
export function settleJournalLegacyCompare(
  db: Database.Database,
  compare: JournalLegacyCompare & ({ held: boolean } | { error: string })
): void {
  const key = `${JOURNAL_LEGACY_COMPARE}${compare.sessionId}`
  if (readMeta(db, key) !== compare.revision) {
    return
  }
  deleteMeta(db, key)
  if ('error' in compare) {
    recordJournalLegacyFailure(db, {
      sessionId: compare.sessionId,
      revision: compare.revision,
      error: new Error(compare.error)
    })
  } else if (compare.held) {
    recordJournalLegacyChatRevision(db, compare.sessionId, compare.revision)
  } else {
    writeMeta(db, `${JOURNAL_LEGACY_COPY_DUE}${compare.sessionId}`, compare.revision)
  }
}

/**
 * Removing an item here leaves its tombstone, so every item this chat converted stays held, at
 * its converted revision or a later one.
 */
function heldEveryItem(
  db: Database.Database,
  id: string,
  pages: Iterable<JournalDomainImportPage>
): boolean {
  const held = new Map(
    db
      .prepare(`SELECT item_id AS id, MAX(revision) AS revision FROM (
          SELECT item_id, revision FROM journal_items WHERE session_id=?1
          UNION ALL SELECT item_id, ?2 FROM journal_item_tombstones WHERE session_id=?1)
        GROUP BY item_id`)
      .all(id, Number.MAX_SAFE_INTEGER)
      .map((row) => [String(row.id), Number(row.revision)])
  )
  for (const page of pages) {
    if (
      page.kind === 'items' &&
      !page.rows.every(({ item }) => (held.get(item.itemId) ?? -1) >= item.revision)
    ) {
      return false
    }
  }
  return true
}
