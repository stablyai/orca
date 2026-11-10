import type { JournalSqlStoreOperation } from './journal-sql-store'

import type { JournalReceiptStage } from './writing/journal-row-writer'

export function receiptRow(operation: JournalSqlStoreOperation): JournalReceiptStage['row'] {
  switch (operation.kind) {
    case 'item':
    case 'item-claiming':
    case 'prompt-mutate':
      return 'item'
    case 'tombstone':
    case 'goal-withdraw':
    case 'stop':
    case 'stop-accept':
    case 'queue-resume':
    case 'queue-reopen':
    case 'queue-reopen-mark':
      return 'tombstone'
    case 'queue-insert':
    case 'queue-update':
    case 'queue-hold':
    case 'queue-withdraw':
    case 'queue-move':
      return 'queue'
    case 'dispatch':
      return 'dispatch'
    case 'submission':
    case 'automatic-submission':
    case 'send-admission':
      return 'submission'
    default:
      return undefined
  }
}
