import type { JournalOutcomeSource } from './journal-outcome-format'
import {
  JOURNAL_OUTCOME_FORMAT_1,
  OUTCOME_FORMAT_1_COLLECTIONS,
  outcomeFormat1StoredScalars
} from './journal-outcome-format-1'
import { JOURNAL_OUTCOME_FORMAT_2, isNativeOutcomeField } from './journal-outcome-format-2'

export type JournalCompactionPosition = { seq: number; field: string; key: string }
export type JournalCompactionSource = JournalOutcomeSource & {
  sessionId: string
  epoch: string
  after: JournalCompactionPosition
}
export type JournalCompactionCandidate = JournalCompactionPosition & {
  format: number
  deleted: number
  bytes: number
}
export type JournalMaintenanceUnit =
  | { kind: 'compact'; active: JournalCompactionSource; rows: JournalCompactionCandidate[] }
  | { kind: 'retired'; generation: number; rows: { rowid: number; bytes: number }[] }
  | { kind: 'vacuum' }

export const JOURNAL_MAINTENANCE_BYTES = 256 * 1024
const fields = new Set<string>(OUTCOME_FORMAT_1_COLLECTIONS)
const scalars = new Set(
  Object.keys(outcomeFormat1StoredScalars.shape).map((key) => JSON.stringify(key))
)

export function admitsJournalOutcome(format: number, field: string, key: string): boolean {
  const ordinary = field === '$' ? scalars.has(key) : fields.has(field)
  return format === JOURNAL_OUTCOME_FORMAT_1
    ? ordinary
    : format === JOURNAL_OUTCOME_FORMAT_2 && (ordinary || isNativeOutcomeField(field))
}

/** One oversized stored value remains intact and runs alone; this is not a time bound. */
export function journalMaintenancePage<T extends { bytes: number }>(rows: readonly T[]): T[] {
  const selected: T[] = []
  let bytes = 0
  for (const row of rows) {
    if (selected.length > 0 && bytes + row.bytes > JOURNAL_MAINTENANCE_BYTES) {
      break
    }
    selected.push(row)
    bytes += row.bytes
    if (selected.length >= 32 || bytes >= JOURNAL_MAINTENANCE_BYTES) {
      break
    }
  }
  return selected
}
