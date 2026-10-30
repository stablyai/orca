import type { CommandReceipt, CommandReceiptScope } from './command-receipt-schema'
import { insertCommandReceiptIfAbsent, type CommandReceiptInsert } from './command-receipt-table'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalRow } from './journal-row-schema'

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
  receipt: CommandReceipt | ((row?: JournalRow) => CommandReceipt)
): JournalOperationReceipt {
  return {
    write: (db, row) => {
      const result = insertCommandReceiptIfAbsent(
        db,
        scope,
        typeof receipt === 'function' ? receipt(row) : receipt
      )
      if (!result.inserted) {
        throw new CommandReceiptExistsError(result)
      }
    },
    committed: () => undefined
  }
}
