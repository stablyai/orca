import type { JournalSqlRequest } from './journal-sql-protocol'

type WriterGate = { beforeWrite(urgent?: boolean): Promise<void>; afterCommit(): void }

/** Times WAL admission separately from the transaction it admits. */
export function journalSqlTimedGate(gate: WriterGate, waited: { ms: number }): WriterGate {
  return {
    beforeWrite: async (urgent) => {
      const startedAt = performance.now()
      try {
        await gate.beforeWrite(urgent)
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
    case 'effects':
    case 'close':
    case 'promote':
      return command.type
  }
}

type ParkedMarks = { bulk: number; urgent: number }

/** When each queued request arrived; time the writer parked for WAL room meanwhile counts as gate time, not queue wait. */
export class JournalSqlQueueClock {
  private readonly received = new Map<number, { at: number; parked: ParkedMarks }>()

  constructor(private readonly parked: () => ParkedMarks) {}

  receive(id: number): void {
    this.received.set(id, { at: performance.now(), parked: this.parked() })
  }

  timing(
    request: Pick<JournalSqlRequest, 'id' | 'urgent' | 'command'>,
    startedAt: number,
    gateMs: number
  ) {
    const queued = this.received.get(request.id)
    // A park on either lane stops the whole writer, so all of it counts as gate time for every queued request.
    const now = this.parked()
    const parked = queued ? now.bulk + now.urgent - queued.parked.bulk - queued.parked.urgent : 0
    return {
      op: journalSqlTimingOp(request.command),
      waitMs: startedAt - (queued?.at ?? startedAt) - parked,
      gateMs: gateMs + parked
    }
  }

  forget(id: number): void {
    this.received.delete(id)
  }
}
