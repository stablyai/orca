// The published view of a conversation's queue: its whole draft list, the queue's
// pause and the card it sends next, on the `commands` precedent — read per emit,
// reference-stable while unchanged, so the subscribers' identity dedup keeps token
// streams from re-sending it. They ride together: a client never sees one without the others.

import {
  QUEUED_MESSAGE_PAUSED_KEPT,
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuedMessagePausedReason,
  type AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  queuePauseLiftOnItsWay,
  resumableQueuePause
} from '../agent-session-journal/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { nextStructuredQueuedMessage } from './structured-agent-session-queued-messages'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** The card the drain sends next as soon as nothing runs (`nextStructuredQueuedMessage`), so a
   *  client reads the run as going across a turn's end and that send, which commit apart. */
  nextQueuedMessageId: string | null
}

/** What the drain's gate reads beyond the journal; resolved per read. */
export type QueueSendGate = () => { record: AgentSessionRecord | null; fence: number }

export function structuredQueueSendGate(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): QueueSendGate {
  return () => ({
    record: store.getRecord(sessionId),
    fence: structuredAgentSessionConversationFence(store, sessionId)
  })
}

/** Waiting and returned rows only. `paused` is a per-card hold (a failed
 *  conversion, or a send the host kept); a Stop or a /clear pauses the queue, published once
 *  beside it. */
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
      ...(held && isPublishedPausedReason(row.holdReason) ? { pausedReason: row.holdReason } : {}),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {}),
      ...(row.state === 'returned' && row.returnedRejection
        ? { returnedRejection: row.returnedRejection }
        : {})
    })
  }
  return published
}

function isPublishedPausedReason(
  reason: string | null
): reason is AgentSessionQueuedMessagePausedReason {
  return reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED || reason === QUEUED_MESSAGE_PAUSED_KEPT
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

export function readQueuePublication(
  journal: AgentSessionJournal,
  gate: QueueSendGate
): QueuePublication {
  const queuedMessages = readPublishedQueuedMessages(journal)
  // Read per emit: the pause also turns on submissions (a turn starting). Shown only over a card
  // Resume would send, so its header never offers to send nothing; deleting a blocking returned
  // card shows it again. After a restart nothing is shown, a Stop's or /clear's included: the
  // chat's next turn lifts every pause, and the cards read as plain waiting cards until then.
  const pauses = structuredQueuePauses(journal)
  const restarted = pauses.some((pause) => pause.reason === 'restarted')
  const resumable = restarted ? null : resumableQueuePause(pauses, journal.queuedMessages.list())
  // The submissions are read only while a pause would show, never while the queue runs freely.
  const pause =
    resumable && !queuePauseLiftOnItsWay(resumable, journal.submissions()) ? resumable : null
  // `restarted` is already excluded above; the test narrows the type.
  const queuePause = pause && pause.reason !== 'restarted' ? { reason: pause.reason } : null
  const nextQueuedMessageId = nextStructuredQueuedMessage({ journal, ...gate() })?.messageId ?? null
  const previous = publications.get(journal)
  if (
    previous &&
    previous.queuedMessages === queuedMessages &&
    sameQueuePause(previous.queuePause, queuePause) &&
    previous.nextQueuedMessageId === nextQueuedMessageId
  ) {
    return previous
  }
  const publication = { queuedMessages, queuePause, nextQueuedMessageId }
  publications.set(journal, publication)
  return publication
}

/** For readers that must never fail on drafts — a subscriber stream, a history
 *  page: a closing handle answers "no claim" (absent) instead of throwing. */
export function tryReadQueuePublication(
  journal: AgentSessionJournal | undefined,
  gate: QueueSendGate
): QueuePublication | undefined {
  try {
    return journal ? readQueuePublication(journal, gate) : undefined
  } catch {
    return undefined
  }
}
