import type { JournalSqlRequest } from './journal-sql-protocol'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'

/** Bulk work gets a turn after this many urgent drains in a row, whenever the WAL admits it. */
const URGENT_STREAK = 8

/** Writer work in two FIFO classes: a sending chat's writes ahead of bulk, with bulk never starved. */
export class JournalSqlWriterQueue {
  private readonly urgent: JournalSqlRequest[] = []
  private readonly bulk: JournalSqlRequest[] = []
  /** Bulk writes queued per chat, so a send that has none moves nothing without a scan. */
  private readonly bulkWrites = new Map<string, number>()
  private streak = 0

  get size(): number {
    return this.urgent.length + this.bulk.length
  }

  /** Returns whether the request queued as urgent. */
  push(request: JournalSqlRequest): boolean {
    if (request.urgent) {
      this.urgent.push(request)
      return true
    }
    this.bulk.push(request)
    this.count(request, 1)
    return false
  }

  /** A chat that starts sending lifts its writes already waiting as bulk; fork installs stay put. */
  promote(sessionId: string): boolean {
    if (!this.bulkWrites.has(sessionId)) {
      return false
    }
    let moved = false
    for (let index = 0; index < this.bulk.length; index++) {
      const request = this.bulk[index]!
      if (sessionOf(request) === sessionId && !isForkInstall(request)) {
        this.bulk.splice(index--, 1)
        this.count(request, -1)
        this.urgent.push({ ...request, urgent: true })
        moved = true
      }
    }
    return moved
  }

  /** The next drain's head; a close always waits for urgent work, which can only precede it. */
  peek(bulkAdmitted: boolean): JournalSqlRequest | undefined {
    return this.source(bulkAdmitted)[0]
  }

  take(bulkAdmitted: boolean): JournalSqlRequest[] {
    const source = this.source(bulkAdmitted)
    const taken = takeJournalSqlReadyBatch(source)
    if (source === this.urgent) {
      this.streak++
    } else {
      this.streak = 0
      for (const request of taken) {
        this.count(request, -1)
      }
    }
    return taken
  }

  private source(bulkAdmitted: boolean): JournalSqlRequest[] {
    const bulkTurn =
      this.streak >= URGENT_STREAK &&
      bulkAdmitted &&
      this.bulk.length > 0 &&
      this.bulk[0]!.command.type !== 'close'
    return this.urgent.length > 0 && !bulkTurn ? this.urgent : this.bulk
  }

  private count(request: JournalSqlRequest, delta: number): void {
    const sessionId = sessionOf(request)
    if (sessionId === undefined) {
      return
    }
    const next = (this.bulkWrites.get(sessionId) ?? 0) + delta
    if (next > 0) {
      this.bulkWrites.set(sessionId, next)
    } else {
      this.bulkWrites.delete(sessionId)
    }
  }
}

function sessionOf(request: JournalSqlRequest): string | undefined {
  return request.command.type === 'write' ? request.command.command.target.sessionId : undefined
}

function isForkInstall(request: JournalSqlRequest): boolean {
  return request.command.type === 'write' && request.command.command.forkInstall !== undefined
}
