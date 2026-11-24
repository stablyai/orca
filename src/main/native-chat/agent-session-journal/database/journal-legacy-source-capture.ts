import { statSync } from 'node:fs'
import {
  JOURNAL_LEGACY_SOURCE_RECEIPT_VERSION,
  journalLegacyFileIdentityFromStat,
  journalLegacySourceReceiptOf,
  type JournalLegacyFileIdentity,
  type JournalLegacySourceReceipt
} from './journal-legacy-source-receipt'

// Synchronous, for the journal SQL worker's open and reconcile only; main reads the receipt async.

export function journalLegacyFileIdentity(filename: string): JournalLegacyFileIdentity {
  return journalLegacyFileIdentityFromStat(
    statSync(filename, { bigint: true, throwIfNoEntry: false })
  )
}

/** Path stats avoid releasing another connection's process-wide SQLite locks on close. */
export function captureJournalLegacySourceReceipt(filename: string): JournalLegacySourceReceipt {
  try {
    const main = statSync(filename, { bigint: true, throwIfNoEntry: false })
    if (!main) {
      return journalLegacySourceReceiptOf(main)
    }
    return journalLegacySourceReceiptOf(
      journalLegacyFileIdentity(filename),
      statSync(`${filename}-wal`, { bigint: true, throwIfNoEntry: false })
    )
  } catch {
    return { ...JOURNAL_LEGACY_SOURCE_RECEIPT_VERSION, disposition: 'uncertifiable' }
  }
}
