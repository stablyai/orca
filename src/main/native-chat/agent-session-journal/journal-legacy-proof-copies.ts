import { JOURNAL_DOMAIN_PROFILE_TABLES } from './database/journal-domain-profile-columns'
import type Database from '../../sqlite/sync-database'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import type { LegacyProofCursor, LegacyProofPage } from './journal-legacy-source-proof'
import {
  journalLegacyCopySourceKey,
  journalLegacyFailureKey
} from './database/journal-legacy-source'
import {
  JOURNAL_LEGACY_COMPARE,
  JOURNAL_LEGACY_COPY_DUE,
  prefixEnd
} from './database/journal-legacy-reconcile-marks'

const COPY_SOURCE = journalLegacyCopySourceKey('')

/**
 * The reconcile's own word on one original chat. A chat it recorded as failed took that revision
 * without its content reaching this store; a compare or copy still due hasn't settled yet.
 */
export function assertLegacyChatSettled(store: Database.Database, sessionId: string): void {
  if (meta(store, journalLegacyFailureKey(sessionId)) !== undefined) {
    throw new JournalLegacyRetentionError(
      'an older Orca chat could not be kept in this store',
      'source-failed'
    )
  }
  if (
    meta(store, `${JOURNAL_LEGACY_COMPARE}${sessionId}`) !== undefined ||
    meta(store, `${JOURNAL_LEGACY_COPY_DUE}${sessionId}`) !== undefined
  ) {
    throw new JournalLegacyRetentionError('an older Orca chat is still being compared')
  }
}

/** The store has every table the proof writes, and no compare due for a chat the original holds. */
export function assertLegacyStoreReady(
  source: Database.Database,
  store: Database.Database,
  tables: boolean
): void {
  assertNoLegacyComparesDue(source, store)
  assertNoLegacyFailures(source, store)
  for (const { name, columns } of tables ? JOURNAL_DOMAIN_PROFILE_TABLES : []) {
    const present = new Set(
      store
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((column) => column.name)
    )
    if (columns.some((column) => !present.has(column))) {
      throw new Error(`legacy proof requires complete destination table ${name}`)
    }
  }
}

/** A chat the original holds that the reconcile recorded as failed, wherever the walk is. */
function assertNoLegacyFailures(source: Database.Database, store: Database.Database): void {
  const prefix = journalLegacyFailureKey('')
  const held = heldBySource(source)
  for (const row of store
    .prepare('SELECT key FROM agent_session_store_meta WHERE key>? AND key<?')
    .iterate(prefix, prefixEnd(prefix))) {
    if (held.get(String(row.key).slice(prefix.length))?.held) {
      throw new JournalLegacyRetentionError(
        'an older Orca chat could not be kept in this store',
        'source-failed'
      )
    }
  }
}

/**
 * Before walking any chat: a compare or copy still due for a chat the original holds would refuse
 * the walk once it reached that chat. One for a chat the original no longer holds settles nothing.
 */
export function assertNoLegacyComparesDue(
  source: Database.Database,
  store: Database.Database
): void {
  const due = store.prepare('SELECT key FROM agent_session_store_meta WHERE key>? AND key<?')
  const held = heldBySource(source)
  for (const prefix of [JOURNAL_LEGACY_COMPARE, JOURNAL_LEGACY_COPY_DUE]) {
    for (const row of due.iterate(prefix, prefixEnd(prefix))) {
      if (held.get(String(row.key).slice(prefix.length))?.held) {
        throw new JournalLegacyRetentionError('an older Orca chat is still being compared')
      }
    }
  }
}

/** Whether the original holds a chat, with history or only a record. */
function heldBySource(source: Database.Database) {
  return source.prepare(`SELECT EXISTS(SELECT 1 FROM journal_sessions WHERE session_id=?1)
    ${hasRecords(source) ? 'OR EXISTS(SELECT 1 FROM agent_session_records WHERE session_id=?1)' : ''}
    AS held`)
}

function hasRecords(source: Database.Database): boolean {
  return !!source
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_session_records'")
    .get()
}

/**
 * Copies the reconcile kept for chats an older Orca continued take their history from the
 * original when they convert, which clears their mapping. Pages of those still mapped at `copies`,
 * then a check at `copies + 1` that none remain: a copy another build readied empty keeps the
 * original. A copy whose chat the original no longer holds has nothing left to take from it.
 */
export function readLegacyCopiesProofPage(
  source: Database.Database,
  store: Database.Database,
  cursor: LegacyProofCursor,
  copies: number
): LegacyProofPage {
  if (cursor.table !== copies) {
    for (let after: string | null = null; ;) {
      const page = readPendingCopies(source, store, after)
      if (page.copies.length > 0) {
        throw new JournalLegacyRetentionError('a copy of an older Orca chat has not converted yet')
      }
      if (page.last === null) {
        return { next: null, sessions: [] }
      }
      after = page.last
    }
  }
  const page = readPendingCopies(source, store, cursor.after)
  return {
    next:
      page.last === null ? { table: copies + 1, after: null } : { table: copies, after: page.last },
    sessions: [],
    copies: page.copies
  }
}

function readPendingCopies(
  source: Database.Database,
  store: Database.Database,
  after: string | null
): { copies: string[]; last: string | null } {
  const rows = store
    .prepare(`SELECT key,value FROM agent_session_store_meta WHERE key>? AND key<? ORDER BY key
      LIMIT 32`)
    .all(`${COPY_SOURCE}${after ?? ''}`, prefixEnd(COPY_SOURCE))
  const held = source.prepare('SELECT 1 FROM journal_sessions WHERE session_id=?')
  const copies: string[] = []
  for (const row of rows) {
    const copy = String(row.key).slice(COPY_SOURCE.length)
    if (!held.get(String(row.value))) {
      continue
    }
    // A copy whose conversion failed is retried only when opened, never by this proof.
    if (meta(store, journalLegacyFailureKey(copy)) !== undefined) {
      throw new JournalLegacyRetentionError(
        'a copy of an older Orca chat could not be converted',
        'source-failed'
      )
    }
    copies.push(copy)
  }
  const tail = rows.at(-1)
  return { copies, last: tail ? String(tail.key).slice(COPY_SOURCE.length) : null }
}

function meta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}
