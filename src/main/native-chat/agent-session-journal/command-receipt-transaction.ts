import type { CommandReceipt, CommandReceiptScope } from './command-receipt-schema'
import type { CommandReceiptInsert } from './command-receipt-table'
import { commandReceiptSchema, commandReceiptScopeSchema } from './command-receipt-schema'
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
      const written = commandReceiptSchema.parse(
        typeof receipt === 'function' ? receipt(row) : receipt
      )
      const claim = commandReceiptScopeSchema.parse(scope)
      if (claim.kind === 'caller' && claim.callerKey !== written.callerKey) {
        throw new Error('command caller does not match its scope')
      }
      db.add({ kind: 'receipt', scope: claim, receipt: written })
    },
    committed: () => undefined
  }
}
