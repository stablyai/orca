import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { readJournalLegacyClaims } from './journal-legacy-adoption'
import { missingJournalLegacyClaims, recoverJournalLegacyClaims } from './journal-legacy-claims'
import { readMeta, recordJournalLegacyFailure, writeMeta } from './journal-legacy-reconcile-marks'
import { journalLegacyFailureKey, openJournalLegacySourceChecked } from './journal-legacy-source'
import {
  sameJournalLegacySource,
  type JournalLegacySourceReceipt
} from './journal-legacy-source-receipt'

/** The original as it was when found damaged, with why; read again only once it changes. */
export const JOURNAL_LEGACY_SOURCE_DAMAGED = 'journal.legacy-source-damaged.v1'

/**
 * Opens the original for a reconcile pass, or undefined when it is damaged: every chat in it would
 * fail alike, so the file is recorded once and its chats are left alone until it changes. Upload
 * claims it can still read are kept first.
 */
export function openReconcilableJournalLegacySource(
  db: Database.Database,
  sourcePath: string,
  captured: JournalLegacySourceReceipt
): Database.Database | undefined {
  const damaged = readMeta(db, JOURNAL_LEGACY_SOURCE_DAMAGED)
  if (damaged !== undefined && sameJournalLegacySource(damagedReceipt(damaged), captured)) {
    return undefined
  }
  const { source, missing } = openJournalLegacySourceChecked(sourcePath)
  if (missing.length === 0) {
    return source
  }
  const error = `the original journal is missing ${missing.join(', ')}`
  try {
    // Its uploads stay claimed here, so the attachment sweep never removes them.
    keepOriginalClaims(source, db, error)
  } finally {
    source.close()
  }
  console.warn(`[agent-session-journal] skipping chats in a damaged older Orca journal: ${error}`)
  const value = JSON.stringify({ receipt: captured, error })
  // An original without a certifiable identity is checked each launch but recorded once.
  if (value !== damaged) {
    runJournalTransaction(db, () => writeMeta(db, JOURNAL_LEGACY_SOURCE_DAMAGED, value))
  }
  return undefined
}

/**
 * Claims a damaged original still lists are kept here. A chat this file doesn't hold yet also keeps
 * a failure record, which is what holds its claims through the sweep until a full pass adopts it.
 */
function keepOriginalClaims(source: Database.Database, db: Database.Database, error: string): void {
  const held = db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
  const failed = db.prepare('SELECT 1 FROM agent_session_store_meta WHERE key=?')
  for (const [id, claims] of readJournalLegacyClaims(source, null)) {
    const holds = held.get(id) !== undefined
    if (
      missingJournalLegacyClaims(db, id, claims).length === 0 &&
      (holds || failed.get(journalLegacyFailureKey(id)) !== undefined)
    ) {
      continue
    }
    recoverJournalLegacyClaims(db, id, claims, (refused) => {
      if (!holds) {
        recordJournalLegacyFailure(db, {
          sessionId: id,
          revision: undefined,
          error,
          claims: refused
        })
      }
    })
  }
}

function damagedReceipt(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && 'receipt' in parsed
      ? JSON.stringify(parsed.receipt)
      : undefined
  } catch {
    return undefined
  }
}
