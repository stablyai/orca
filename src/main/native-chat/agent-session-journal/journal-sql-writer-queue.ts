import type { JournalSqlRequest } from './journal-sql-protocol'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'

/** A ready batch holds at most 64 requests, so taking one never reads further into the queue. */
const BATCH_WINDOW = 64

/** Writer work in two FIFO classes: a sending chat's writes always run ahead of bulk. */
export class JournalSqlWriterQueue {
  private readonly urgent: JournalSqlRequest[] = []
  /** Insertion-ordered by request id, so taking or promoting a request never splices. */
  private readonly bulk = new Map<number, JournalSqlRequest>()

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
    return false
  }

  /** A chat that starts sending lifts its writes already waiting as bulk; fork installs stay put. */
  promote(sessionId: string): boolean {
    let moved = false
    // One pass per send; each chat's lane keeps at most one request queued.
    for (const request of this.bulk.values()) {
      if (sessionOf(request) === sessionId && !isForkInstall(request)) {
        this.bulk.delete(request.id)
        this.urgent.push({ ...request, urgent: true })
        moved = true
      }
    }
    return moved
  }

  /** The next drain's head; a close is bulk, so it always runs after queued urgent work. */
  peek(): JournalSqlRequest | undefined {
    return this.urgent[0] ?? this.bulk.values().next().value
  }

  take(): JournalSqlRequest[] {
    if (this.urgent.length > 0) {
      return takeJournalSqlReadyBatch(this.urgent)
    }
    const window: JournalSqlRequest[] = []
    for (const request of this.bulk.values()) {
      window.push(request)
      if (window.length === BATCH_WINDOW) {
        break
      }
    }
    const taken = takeJournalSqlReadyBatch(window)
    for (const request of taken) {
      this.bulk.delete(request.id)
    }
    return taken
  }
}

function sessionOf(request: JournalSqlRequest): string | undefined {
  return request.command.type === 'write' ? request.command.command.target.sessionId : undefined
}

function isForkInstall(request: JournalSqlRequest): boolean {
  return request.command.type === 'write' && request.command.command.forkInstall !== undefined
}
