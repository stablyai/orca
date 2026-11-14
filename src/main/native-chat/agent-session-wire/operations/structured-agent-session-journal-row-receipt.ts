import type { CommandReceiptResult } from '../../agent-session-journal/writing/command-receipt-schema'
import type { JournalRow } from '../../agent-session-journal/durable-rows/journal-row-schema'

export function journalRowReceiptResult(
  row: JournalRow | undefined,
  ...kinds: JournalRow['kind'][]
): CommandReceiptResult {
  if (!row || !kinds.includes(row.kind)) {
    throw new Error(`an accepted command requires its ${kinds.join(' or ')} row`)
  }
  return { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
}
