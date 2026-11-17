import type { JournalSqlRequest } from './journal-sql-protocol'

type WriterGate = { beforeWrite(): Promise<void>; afterCommit(): void }

/** Times WAL admission separately from the transaction it admits. */
export function journalSqlTimedGate(gate: WriterGate, waited: { ms: number }): WriterGate {
  return {
    beforeWrite: async () => {
      const startedAt = performance.now()
      try {
        await gate.beforeWrite()
      } finally {
        waited.ms += performance.now() - startedAt
      }
    },
    afterCommit: () => gate.afterCommit()
  }
}

export function journalSqlTimingOp(command: JournalSqlRequest['command']): string {
  switch (command.type) {
    case 'write':
      return command.command.operation.kind
    case 'maintenance':
      return `maintenance:${command.operation.kind}`
    default:
      return command.type
  }
}
