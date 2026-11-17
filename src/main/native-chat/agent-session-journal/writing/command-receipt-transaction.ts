import type { CommandReceipt, CommandReceiptScope } from './command-receipt-schema'
import { insertCommandReceiptIfAbsent, type CommandReceiptInsert } from './command-receipt-table'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { JournalReceiptRowBinding } from '../journal-writer-effects'

type CommandReceiptNotInserted = Extract<CommandReceiptInsert, { inserted: false }>

/** Roll back the enclosing effect before replaying, refusing conflict or answering unknown. */
export class CommandReceiptExistsError extends Error {
  constructor(readonly result: CommandReceiptNotInserted) {
    super(`command receipt already exists: ${result.reason}`)
    this.name = 'CommandReceiptExistsError'
  }
}

export function buildCommandReceiptTransaction(
  scope: CommandReceiptScope,
  receipt: CommandReceipt,
  binding?: JournalReceiptRowBinding,
  committed?: (receipt: CommandReceipt, row: JournalRow['kind'] | null) => void
): JournalOperationReceipt {
  return {
    write: (db) => {
      const result = insertCommandReceiptIfAbsent(db, scope, receipt)
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
    },
    committed: () => committed?.(receipt, null),
    stage: async () => ({
      effects: [{ kind: 'receipt', scope, receipt, ...(binding ? { row: binding } : {}) }],
      settle: (results) => {
        if (results === undefined) {
          return
        }
        const result = results[0]
        if (
          results.length !== 1 ||
          !result ||
          typeof result !== 'object' ||
          !('receipt' in result) ||
          !('row' in result)
        ) {
          throw new Error('the writer returned a missing command receipt')
        }
        committed?.(result.receipt, result.row)
      }
    })
  }
}
