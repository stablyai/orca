import type { JournalSqlRequest } from './journal-sql-protocol'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'

/** Bulk work gets a turn after this many urgent drains in a row, whenever the WAL admits it. */
const URGENT_STREAK = 8
/** A ready batch holds at most 64 requests, so taking one never reads further into the queue. */
const BATCH_WINDOW = 64

/** Writer work in two FIFO classes: a sending chat's writes ahead of bulk, with bulk never starved. */
export class JournalSqlWriterQueue {
  private readonly urgent: JournalSqlRequest[] = []
  /** Insertion-ordered by request id, so a promoted request leaves without a scan. */
  private readonly bulk = new Map<number, JournalSqlRequest>()
  private readonly bulkByChat = new Map<string, Set<number>>()
  private streak = 0

  get size(): number {
    return this.urgent.length + this.bulk.size
  }

  /** Returns whether the request queued as urgent. */
  push(request: JournalSqlRequest): boolean {
    if (request.urgent) {
      this.urgent.push(request)
      return true
    }
    this.bulk.set(request.id, request)
    const sessionId = sessionOf(request)
    if (sessionId !== undefined) {
      const ids = this.bulkByChat.get(sessionId) ?? new Set<number>()
      ids.add(request.id)
      this.bulkByChat.set(sessionId, ids)
    }
    return false
  }

  /** A chat that starts sending lifts its writes already waiting as bulk; fork installs stay put. */
  promote(sessionId: string): boolean {
    let moved = false
    for (const id of this.bulkByChat.get(sessionId) ?? []) {
      const request = this.bulk.get(id)!
      if (!isForkInstall(request)) {
        this.removeBulk(request)
        this.urgent.push({ ...request, urgent: true })
        moved = true
      }
    }
    return moved
  }

  /** The next drain's head; a close always waits for urgent work, which can only precede it. */
  peek(bulkAdmitted: boolean): JournalSqlRequest | undefined {
    return this.bulkTurn(bulkAdmitted) ? this.firstBulk() : this.urgent[0]
  }

  take(bulkAdmitted: boolean): JournalSqlRequest[] {
    if (!this.bulkTurn(bulkAdmitted)) {
      this.streak++
      return takeJournalSqlReadyBatch(this.urgent)
    }
    this.streak = 0
    const window: JournalSqlRequest[] = []
    for (const request of this.bulk.values()) {
      window.push(request)
      if (window.length === BATCH_WINDOW) {
        break
      }
    }
    const taken = takeJournalSqlReadyBatch(window)
    for (const request of taken) {
      this.removeBulk(request)
    }
    return taken
  }

  private bulkTurn(bulkAdmitted: boolean): boolean {
    if (this.urgent.length === 0) {
      return true
    }
    return (
      this.streak >= URGENT_STREAK &&
      bulkAdmitted &&
      this.bulk.size > 0 &&
      this.firstBulk()!.command.type !== 'close'
    )
  }

  private firstBulk(): JournalSqlRequest | undefined {
    return this.bulk.values().next().value
  }

  private removeBulk(request: JournalSqlRequest): void {
    this.bulk.delete(request.id)
    const sessionId = sessionOf(request)
    const ids = sessionId === undefined ? undefined : this.bulkByChat.get(sessionId)
    ids?.delete(request.id)
    if (sessionId !== undefined && ids?.size === 0) {
      this.bulkByChat.delete(sessionId)
    }
  }
}

function sessionOf(request: JournalSqlRequest): string | undefined {
  return request.command.type === 'write' ? request.command.command.target.sessionId : undefined
}

function isForkInstall(request: JournalSqlRequest): boolean {
  return request.command.type === 'write' && request.command.command.forkInstall !== undefined
}
