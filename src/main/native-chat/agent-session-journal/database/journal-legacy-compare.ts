import type Database from '../../../sqlite/sync-database'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../../sqlite/sqlite-read-failure'
import { isUnsettledQueuedMessage } from '../queued-messages/queued-message-table'
import { prepareJournalDomainImport, type JournalDomainImportPage } from '../journal-domain-import'
import {
  journalLegacyChatRevision,
  journalLegacyFailureKey,
  recordJournalLegacyChatRevision,
  settleJournalLegacyCopy
} from './journal-legacy-source'
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

/**
 * Whether this file already holds every item of the original chat. Runs on a reader, one chat per
 * idle step, and stops at the first item this chat never held. Its unit is the chat's restore,
 * the same one converting that chat takes; an interrupted compare restarts that chat. Only the
 * original's failures are the chat's answer; this file's own failures throw and stay pending.
 */
export function compareJournalLegacyChat(
  openSource: () => Database.Database | undefined,
  db: Database.Database,
  sessionId: string
): { revision: string; held: boolean } | { error: string } | null {
  let source: Database.Database | undefined
  try {
    source = openSource()
  } catch (error) {
    // An original that won't open is no chat's answer; it ends the pass until it opens again.
    if (isSqliteCorruption(error)) {
      return null
    }
    return originalFailure(error)
  }
  // With no original there is nothing to compare, so this file isn't read.
  if (!source) {
    return null
  }
  const held = { items: heldItems(db, sessionId), cards: heldCards(db, sessionId) }
  try {
    const imported = prepareJournalDomainImport(source, sessionId)
    if (!imported) {
      return { revision: journalLegacyChatRevision(source, sessionId) ?? 'null', held: true }
    }
    return {
      revision: imported.sourceRevision ?? 'null',
      held: heldEveryItem(held, imported.pages)
    }
  } catch (error) {
    return originalFailure(error)
  }
}

function originalFailure(error: unknown): { error: string } {
  if (isSqliteStorageFailure(error)) {
    throw error
  }
  return { error: error instanceof Error ? error.message : String(error) }
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
    console.warn('[agent-session-journal] keeping an older Orca chat failed', compare.error)
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
function heldItems(db: Database.Database, id: string): Map<string, number> {
  return new Map(
    db
      .prepare(`SELECT item_id AS id, MAX(revision) AS revision FROM (
          SELECT item_id, revision FROM journal_items WHERE session_id=?1
          UNION ALL SELECT item_id, ?2 FROM journal_item_tombstones WHERE session_id=?1)
        GROUP BY item_id`)
      .all(id, Number.MAX_SAFE_INTEGER)
      .map((row) => [String(row.id), Number(row.revision)])
  )
}

/** Every card this chat ever queued, whatever became of it. */
function heldCards(db: Database.Database, id: string): Set<string> {
  return new Set(
    db
      .prepare('SELECT DISTINCT message_id AS id FROM journal_queue_cards WHERE session_id=?')
      .all(id)
      .map((row) => String(row.id))
  )
}

/** A message the older Orca queued and never sent has no item, only its card. */
function heldEveryItem(
  held: { items: Map<string, number>; cards: Set<string> },
  pages: Iterable<JournalDomainImportPage>
): boolean {
  for (const page of pages) {
    if (
      page.kind === 'items' &&
      !page.rows.every(({ item }) => (held.items.get(item.itemId) ?? -1) >= item.revision)
    ) {
      return false
    }
    if (
      page.kind === 'cards' &&
      page.rows.some((card) => isUnsettledQueuedMessage(card) && !held.cards.has(card.messageId))
    ) {
      return false
    }
  }
  return true
}

/**
 * A forgotten chat takes the revision its compare or copy waited on, so an older Orca's unchanged
 * copy never brings it back; a forgotten copy drops its mapping, so no key outlives it.
 */
export function absorbForgottenJournalLegacyChat(db: Database.Database, sessionId: string): void {
  for (const prefix of [JOURNAL_LEGACY_COMPARE, JOURNAL_LEGACY_COPY_DUE]) {
    const revision = readMeta(db, `${prefix}${sessionId}`)
    if (revision !== undefined) {
      deleteMeta(db, `${prefix}${sessionId}`)
      recordJournalLegacyChatRevision(db, sessionId, revision)
    }
  }
  settleJournalLegacyCopy(db, sessionId)
  deleteMeta(db, journalLegacyFailureKey(sessionId))
}
