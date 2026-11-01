import type { JournalRow } from './journal-row-schema'

export function serializeJournalRow(row: JournalRow): string {
  return JSON.stringify(row)
}

export function journalRowByteLength(row: JournalRow): number {
  return Buffer.byteLength(serializeJournalRow(row), 'utf8') + 1
}
