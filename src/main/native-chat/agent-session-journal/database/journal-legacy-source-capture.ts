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

/** Copying may read a linked original. Only a single-link original establishes retirement custody. */
export function captureJournalLegacyInitializationSource(filename: string): {
  receipt: JournalLegacySourceReceipt
  stability: JournalLegacySourceReceipt
} {
  const unknown: JournalLegacySourceReceipt = {
    ...JOURNAL_LEGACY_SOURCE_RECEIPT_VERSION,
    disposition: 'uncertifiable'
  }
  try {
    const main = statSync(filename, { bigint: true, throwIfNoEntry: false })
    const stability = main
      ? journalLegacySourceReceiptOf(
          journalLegacyFileIdentityFromStat(main, false),
          statSync(`${filename}-wal`, { bigint: true, throwIfNoEntry: false })
        )
      : journalLegacySourceReceiptOf()
    return { receipt: main && main.nlink !== 1n ? unknown : stability, stability }
  } catch {
    return { receipt: unknown, stability: unknown }
  }
}
