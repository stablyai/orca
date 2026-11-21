import type { JournalSqlRequest } from './journal-sql-protocol'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'

/** A ready batch holds at most 64 requests, so taking one never reads further into the queue. */
const BATCH_WINDOW = 64

/** Writer work in two FIFO classes: a sending chat's writes always run ahead of bulk. */
export class JournalSqlWriterQueue {
  private readonly urgent: JournalSqlRequest[] = []
  /** Insertion-ordered by request id, so taking or promoting a request never splices. */
  private readonly bulk = new Map<number, JournalSqlRequest>()
  /** Each chat's queued bulk request ids, so a send's promotion never walks other chats' work. */
  private readonly bulkByChat = new Map<string, Set<number>>()

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

  /** A rolled-back batch goes back ahead of everything in its class, each request alone. */
  retryAlone(requests: readonly JournalSqlRequest[]): void {
    const alone = requests.map(({ batch: _batch, ...request }) => request)
    if (alone[0]?.urgent) {
      this.urgent.unshift(...alone)
      return
    }
    const rest = [...this.bulk.values()]
    this.bulk.clear()
    for (const request of [...alone, ...rest]) {
      this.bulk.set(request.id, request)
    }
    for (const request of alone) {
      const sessionId = sessionOf(request)
      if (sessionId !== undefined) {
        this.bulkByChat.set(
          sessionId,
          (this.bulkByChat.get(sessionId) ?? new Set()).add(request.id)
        )
      }
    }
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
      this.removeBulk(request)
    }
    return taken
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
