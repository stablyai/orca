import type { JournalSqlReaderOperation } from './journal-sql-reader-protocol'
import {
  describeJournalReaderOperation,
  recordJournalReaderRequest,
  type JournalReaderRunningRequest
} from './journal-sql-reader-requests'

type PendingRead = { operation: JournalSqlReaderOperation; chat?: string | null }

/** Replies are FIFO: the oldest unanswered request is running, or answered but not yet read. */
export class JournalReaderRunningRecord {
  /** Ids only grow, so the oldest pending id only moves forward. */
  private oldestId = 1
  private running?: { id: number; queued: number; request: JournalReaderRunningRequest }

  constructor(private record: number | undefined) {}

  release(): void {
    this.record = undefined
  }

  update(pending: ReadonlyMap<number, PendingRead>, nextId: number, threadId: number | null): void {
    if (this.record === undefined) {
      return
    }
    const oldest = this.oldestPending(pending, nextId)
    const queued = pending.size - 1
    if (
      oldest?.[0] === this.running?.id &&
      queued === this.running?.queued &&
      threadId === this.running?.request.threadId
    ) {
      return
    }
    if (!oldest) {
      if (this.running) {
        this.running = undefined
        recordJournalReaderRequest(this.record, null)
      }
      return
    }
    const [id, { operation, chat }] = oldest
    let request: JournalReaderRunningRequest
    if (id === this.running?.id) {
      request = { ...this.running.request, queued, threadId }
    } else {
      const described = describeJournalReaderOperation(operation)
      request = {
        operation: described.operation,
        chat: chat === undefined ? described.chat : chat,
        startedAt: Date.now(),
        queued,
        threadId
      }
    }
    this.running = { id, queued, request }
    recordJournalReaderRequest(this.record, request)
  }

  // A Map's first entry walks over deleted ones, so draining a long queue that way is quadratic.
  private oldestPending(pending: ReadonlyMap<number, PendingRead>, nextId: number) {
    while (this.oldestId <= nextId && !pending.has(this.oldestId)) {
      this.oldestId++
    }
    const entry = pending.get(this.oldestId)
    return entry && ([this.oldestId, entry] as const)
  }
}
