// Crash-window recovery: the common pattern starts a watch only from a live call, so the only
// calls replayed are ones that finished just before this service started, with no live observer.

import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import {
  readJournalRowsAfterCursor,
  type JournalReadRow
} from '../../native-chat/agent-session-journal/journal-read-row'
import type Database from '../../sqlite/sync-database'
import { finishedShellCall, type PRChatToolCall } from './pr-chat-action-recorder'

type ReplayJournal = Pick<AgentSessionJournal, 'physicalCursor' | 'item'> & { sessionId: string }

/** When a stored write's first item began; null for writes that touch no item. */
function writeStartedAt(row: JournalReadRow, journal: ReplayJournal): number | null {
  const itemId = row.kind === 'outcome' ? row.itemIds[0] : row.kind === 'item' ? row.itemId : null
  return itemId ? (journal.item(itemId)?.observedAt ?? null) : null
}

/**
 * Finished shell calls that completed in `[since, before)`: a crash window. Writes are stored in
 * sequence order, so a binary search over sequences finds the window's first write and only the
 * window is read, never the whole journal. A call's completion is its start plus the duration the
 * agent reported; with no duration a long call that began before the window is missed, never
 * replayed late.
 */
export function journalShellCallsFinishedBetween(
  db: Database.Database,
  journal: ReplayJournal,
  since: number,
  before: number
): PRChatToolCall[] {
  const { epoch, sequence } = journal.physicalCursor()
  const after = (seq: number, limit?: number) =>
    readJournalRowsAfterCursor(db, journal.sessionId, epoch, seq, limit).rows
  let low = 0
  let high = sequence
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const row = after(middle, 1)[0]
    const startedAt = row ? writeStartedAt(row, journal) : null
    if (startedAt === null || startedAt >= since) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  const calls = new Map<string, PRChatToolCall>()
  for (const row of after(Math.max(0, low - 1))) {
    const itemIds = row.kind === 'outcome' ? row.itemIds : row.kind === 'item' ? [row.itemId] : []
    for (const itemId of itemIds) {
      const item = journal.item(itemId)
      const duration = item?.body.kind === 'tool-call' ? (item.body.durationMs ?? 0) : 0
      const call = item
        ? finishedShellCall(journal.sessionId, item, item.observedAt + duration)
        : null
      if (call && call.finishedAt >= since && call.finishedAt < before) {
        calls.set(itemId, call)
      }
    }
  }
  return [...calls.values()]
}

const CRASH_WINDOW_MS = 2 * 60 * 60_000

/** Replays the calls that finished in the 2 hours before `startedAt`; resolves whether all of
 *  them could be handled, so a partial replay stays retryable. */
export async function replayCrashWindow(input: {
  db: Database.Database
  journal: ReplayJournal
  startedAt: number
  record: (calls: PRChatToolCall[]) => Promise<boolean>
}): Promise<boolean> {
  const { startedAt } = input
  const since = startedAt - CRASH_WINDOW_MS
  return input.record(journalShellCallsFinishedBetween(input.db, input.journal, since, startedAt))
}

/** Replayed actions' heads: a first read that is already final seeds memory without a line. */
export class PRReplayedHeads {
  private readonly heads = new Map<string, { current: boolean; shas: Set<string> }>()

  /** A replayed `opened` action names no head, so its PR's next current-head read is the first. */
  mark(prKey: string, headSha: string | null): void {
    const entry = this.heads.get(prKey) ?? { current: false, shas: new Set<string>() }
    entry.current ||= headSha === null
    if (headSha) {
      entry.shas.add(headSha)
    }
    this.heads.set(prKey, entry)
  }

  /** Whether this read is a replayed head's first; each answers once. */
  takeFirstRead(prKey: string, headSha: string, isCurrentHead: boolean): boolean {
    const entry = this.heads.get(prKey)
    if (!entry) {
      return false
    }
    const first = (isCurrentHead && entry.current) || entry.shas.has(headSha)
    entry.current &&= !isCurrentHead
    entry.shas.delete(headSha)
    if (!entry.current && entry.shas.size === 0) {
      this.heads.delete(prKey)
    }
    return first
  }

  clear(): void {
    this.heads.clear()
  }
}
