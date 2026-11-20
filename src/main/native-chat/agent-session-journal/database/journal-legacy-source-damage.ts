import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { readMeta, writeMeta } from './journal-legacy-reconcile-marks'
import { JournalLegacySourceDamagedError, openJournalLegacySource } from './journal-legacy-source'
import {
  sameJournalLegacySource,
  type JournalLegacySourceReceipt
} from './journal-legacy-source-receipt'

/** The original as it was when found damaged, with why; read again only once it changes. */
export const JOURNAL_LEGACY_SOURCE_DAMAGED = 'journal.legacy-source-damaged.v1'

/**
 * Opens the original for a reconcile pass, or undefined when it is damaged: every chat in it would
 * fail alike, so the file is recorded once and its chats are left alone until it changes.
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
  try {
    return openJournalLegacySource(sourcePath, { complete: true })
  } catch (error) {
    if (!(error instanceof JournalLegacySourceDamagedError)) {
      throw error
    }
    console.warn('[agent-session-journal] skipping chats in a damaged older Orca journal', error)
    const value = JSON.stringify({ receipt: captured, error: error.message })
    // An original without a certifiable identity is checked each launch but recorded once.
    if (value !== damaged) {
      runJournalTransaction(db, () => writeMeta(db, JOURNAL_LEGACY_SOURCE_DAMAGED, value))
    }
    return undefined
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
