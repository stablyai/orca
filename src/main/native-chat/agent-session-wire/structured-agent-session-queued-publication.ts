// The published view of a conversation's queue: its whole draft list and the
// queue's pause, on the `commands` precedent — read per emit, reference-stable
// while unchanged, so the subscribers' identity dedup keeps token streams from
// re-sending it. The two ride together: a client never sees one without the other.

import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { hasResumableQueuedMessage } from '../agent-session-journal/queued-message-pause-table'
import { structuredQueuePause } from './structured-agent-session-queued-pause'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
}

/** Waiting and returned rows only. `paused` is a per-card hold (a failed
 *  conversion); a Stop or a restart pauses the queue, published once beside it. */
function computePublishedQueuedMessages(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const held = row.state === 'waiting' && row.holdReason !== null
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(held ? { paused: true as const } : {}),
      // The stored reason is a typed marker; an unknown one reads as a plain hold.
      ...(held && row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
        ? { pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
        : {}),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {}),
      ...(row.state === 'returned' && row.returnedRejection
        ? { returnedRejection: row.returnedRejection }
        : {})
    })
  }
  return published
}

type ListMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Reference-stable per journal handle: an unchanged list is never
 *  re-serialized onto token-stream frames, and any draft-table write changes
 *  the reference by construction. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()

function readPublishedQueuedMessages(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  const key = String(journal.queuedMessages.revision())
  const memo = listMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = computePublishedQueuedMessages(journal)
  // Belt for the identity dedup: equal recomputed content keeps the previous reference.
  const serialized = JSON.stringify(list)
  if (memo && memo.serialized === serialized) {
    listMemos.set(journal, { key, serialized, list: memo.list })
    return memo.list
  }
  listMemos.set(journal, { key, serialized, list })
  return list
}

/** Presence first: a pause appearing or clearing is a change even when neither side
 *  names a reason this build can read. */
export function sameQueuePause(
  previous: { reason?: string } | null,
  next: { reason?: string } | null
): boolean {
  return (previous === null) === (next === null) && previous?.reason === next?.reason
}

export function readQueuePublication(journal: AgentSessionJournal): QueuePublication {
  const queuedMessages = readPublishedQueuedMessages(journal)
  // Read per emit: the pause also turns on submissions (a person's turn starting).
  // Kept over any card it holds back, but shown only over one Resume would send, so its
  // header never offers to send nothing; deleting a blocking returned card shows it again.
  const pausable = hasResumableQueuedMessage(journal.queuedMessages.list())
  const queuePause = pausable ? structuredQueuePause(journal) : null
  const previous = publications.get(journal)
  if (
    previous &&
    previous.queuedMessages === queuedMessages &&
    sameQueuePause(previous.queuePause, queuePause)
  ) {
    return previous
  }
  const publication = { queuedMessages, queuePause }
  publications.set(journal, publication)
  return publication
}

/** For readers that must never fail on drafts — a subscriber stream, a history
 *  page: a closing handle answers "no claim" (absent) instead of throwing. */
export function tryReadQueuePublication(
  journal: AgentSessionJournal | undefined
): QueuePublication | undefined {
  try {
    return journal ? readQueuePublication(journal) : undefined
  } catch {
    return undefined
  }
}
