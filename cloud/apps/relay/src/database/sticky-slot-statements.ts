import { AsyncLocalStorage } from 'node:async_hooks'

export type StickySlotSample = {
  queueWaitMs: number
  // Waiting for a pooled connection, apart from the statements run on one.
  poolWaitMs: number
  sqlMs: number
  statements: number
  statementMsByConnection: ReadonlyMap<number, readonly number[]>
}

type StickySlotStatementTotals = Omit<StickySlotSample, 'queueWaitMs'>

// Count PostgreSQL trips except ROLLBACK while sticky slot is held; exclude work still running after release.
export class StickySlotStatements {
  private closed = false
  private poolWaitMs = 0
  private sqlMs = 0
  private statements = 0
  private readonly statementMsByConnection = new Map<number, number[]>()

  notePoolWait(durationMs: number): void {
    if (!this.closed) this.poolWaitMs += durationMs
  }

  noteStatement(durationMs: number, connectionId: number): void {
    if (this.closed) return
    this.statements++
    this.sqlMs += durationMs
    const samples = this.statementMsByConnection.get(connectionId)
    if (samples) samples.push(durationMs)
    else this.statementMsByConnection.set(connectionId, [durationMs])
  }

  close(): StickySlotStatementTotals {
    this.closed = true
    return {
      poolWaitMs: this.poolWaitMs,
      sqlMs: this.sqlMs,
      statements: this.statements,
      statementMsByConnection: this.statementMsByConnection
    }
  }
}

const activeStickySlot = new AsyncLocalStorage<StickySlotStatements>()

export function runInStickySlot<T>(
  statements: StickySlotStatements,
  work: () => Promise<T>
): Promise<T> {
  return activeStickySlot.run(statements, work)
}

export function noteStickySlotPoolWait(durationMs: number): void {
  activeStickySlot.getStore()?.notePoolWait(durationMs)
}

export function noteStickySlotStatement(durationMs: number, connectionId: number): void {
  activeStickySlot.getStore()?.noteStatement(durationMs, connectionId)
}
