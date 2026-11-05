export const MAX_RESTORABLE_TERMINAL_HISTORY_SESSIONS = 10_000

export type RestorableTerminalHistorySession = {
  sessionId: string
  startedAtMs: number
  order: number
}

function compareRecency(
  left: RestorableTerminalHistorySession,
  right: RestorableTerminalHistorySession
): number {
  return left.startedAtMs - right.startedAtMs || left.order - right.order
}

function siftDownOldest(heap: RestorableTerminalHistorySession[], startIndex: number): void {
  let index = startIndex
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) {
      return
    }
    const right = left + 1
    const oldestChild =
      right < heap.length && compareRecency(heap[right], heap[left]) < 0 ? right : left
    if (compareRecency(heap[index], heap[oldestChild]) <= 0) {
      return
    }
    const current = heap[index]
    heap[index] = heap[oldestChild]
    heap[oldestChild] = current
    index = oldestChild
  }
}

function heapifyOldestFirst(heap: RestorableTerminalHistorySession[]): void {
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index--) {
    siftDownOldest(heap, index)
  }
}

export function retainNewestRestorableTerminalHistorySessions(
  sessions: Iterable<RestorableTerminalHistorySession>,
  limit = MAX_RESTORABLE_TERMINAL_HISTORY_SESSIONS
): string[] {
  const retained: RestorableTerminalHistorySession[] = []
  let overflowed = false

  for (const session of sessions) {
    if (retained.length < limit) {
      retained.push(session)
      continue
    }
    if (!overflowed) {
      heapifyOldestFirst(retained)
      overflowed = true
    }
    if (compareRecency(session, retained[0]) <= 0) {
      continue
    }
    retained[0] = session
    siftDownOldest(retained, 0)
  }

  if (overflowed) {
    retained.sort((left, right) => left.order - right.order)
  }
  return retained.map((session) => session.sessionId)
}
