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

/**
 * Copies the reconcile kept for chats an older Orca continued take their history from the
 * original when they convert, which clears their mapping. Pages of those still mapped at `copies`,
 * then a check at `copies + 1` that none remain: a copy another build readied empty keeps the
 * original.
 */
export function readLegacyCopiesProofPage(
  store: Database.Database,
  cursor: LegacyProofCursor,
  copies: number
): LegacyProofPage {
  const pending = readPendingCopies(store, cursor.table === copies ? cursor.after : null)
  if (cursor.table !== copies) {
    if (pending.length > 0) {
      throw new JournalLegacyRetentionError('a copy of an older Orca chat has not converted yet')
    }
    return { next: null, sessions: [] }
  }
  return {
    next: pending.length
      ? { table: copies, after: pending.at(-1)! }
      : { table: copies + 1, after: null },
    sessions: [],
    copies: pending
  }
}

function readPendingCopies(store: Database.Database, after: string | null): string[] {
  return store
    .prepare('SELECT key FROM agent_session_store_meta WHERE key>? AND key<? ORDER BY key LIMIT 32')
    .all(`${COPY_SOURCE}${after ?? ''}`, prefixEnd(COPY_SOURCE))
    .map((row) => String(row.key).slice(COPY_SOURCE.length))
}

function meta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}
