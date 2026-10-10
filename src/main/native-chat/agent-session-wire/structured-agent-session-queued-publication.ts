// The published view of a conversation's queue: its whole draft list, the queue's
// pause and the card it sends next, on the `commands` precedent — read per emit,
// reference-stable while unchanged, so the subscribers' identity dedup keeps token
// streams from re-sending it. They ride together: a client never sees one without the others.

import {
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
import {
  nextStructuredQueuedMessage,
  type StructuredQueueGateInput
} from './structured-agent-session-queued-messages'
import { structuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionCurrentWorkHost } from './structured-agent-session-host-current-work'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** The card the drain sends next as soon as nothing runs (`nextStructuredQueuedMessage`), so a
   *  client reads the run as going across a turn's end and that send, which commit apart. */
  nextQueuedMessageId: string | null
}

/** What the drain's gate reads beyond the journal; resolved per read. `abandoned`: the card whose
 *  automatic send was given up on, shown as not sent. */
export type QueueSendGate = (
  journal: AgentSessionJournal
) => StructuredQueueGateInput & { abandoned?: string }

/** What the drain itself holds back (`StructuredAgentSessionQueuedMessageDrain`). */
export type QueuedDrainHolds = {
  waits: (sessionId: string, messageId: string) => boolean
  abandonedCard: (sessionId: string) => string | undefined
}

/** `drain`: the drain's own holds, which a publication reads so a client is never told a card
 *  sends next while the drain holds it back (the chat would read Working with nothing running). */
export function structuredQueueSendGate(
  host: StructuredAgentSessionCurrentWorkHost,
  sessionId: string,
  drain?: QueuedDrainHolds
): QueueSendGate {
  return (journal) => {
    const record = host.store.getRecord(sessionId)
    const session = host.sessions.get(sessionId)
    const ended = session?.lastEndedChild
    const abandoned = drain?.abandonedCard(sessionId)
    return {
      record,
      work: structuredAgentSessionCurrentWork(journal, {
        record,
        replaced: host.store.replacedRuntime(sessionId),
        ...(session ? { child: session.child } : {}),
        ...(ended ? { ended } : {})
      }),
      ...(drain ? { drainWaits: (messageId: string) => drain.waits(sessionId, messageId) } : {}),
      ...(abandoned ? { abandoned } : {})
    }
  }
}

/** Waiting and returned rows only. `paused` is a per-card hold (a failed conversion); a person's
 *  Stop pauses the queue, published once beside it. */
function computePublishedQueuedMessages(
  journal: AgentSessionJournal,
  abandoned: string | undefined
): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    // A send given up on reads as main's failed send even when its stored hold did not land.
    const holdReason =
      row.messageId === abandoned ? QUEUED_MESSAGE_PAUSED_SEND_FAILED : row.holdReason
    const held = row.state === 'waiting' && holdReason !== null
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(held ? { paused: true as const } : {}),
      // The stored reason is a typed marker; an unknown one reads as a plain hold.
      ...(held && isPublishedPausedReason(holdReason) ? { pausedReason: holdReason } : {}),
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
  return reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
}

type ListMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Reference-stable per journal handle: an unchanged list is never
 *  re-serialized onto token-stream frames, and any draft-table write changes
 *  the reference by construction. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()

function readPublishedQueuedMessages(
  journal: AgentSessionJournal,
  abandoned: string | undefined
): AgentSessionQueuedMessage[] {
  const key = `${journal.queuedMessages.revision()}:${abandoned ?? ''}`
  const memo = listMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = computePublishedQueuedMessages(journal, abandoned)
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
  const input = gate(journal)
  const queuedMessages = readPublishedQueuedMessages(journal, input.abandoned)
  // Read per emit: the pause also turns on submissions (a turn starting). Only a person's Stop is
  // shown, and only over a card Resume would send, so its header never offers to send nothing;
  // deleting a blocking returned card shows it again. After a /clear, a restart or a close nothing
  // is shown, a Stop's from before it included: nothing runs in the chat, its next turn lifts every
  // pause, and the cards read as plain waiting cards until then. A Stop the person makes after the
  // reopen shows.
  const pauses = structuredQueuePauses(journal)
  const stop = pauses.find((pause) => pause.reason === 'stopped')?.since
  const silent = pauses.some(
    (pause) =>
      pause.reason === 'cleared' ||
      (pause.reason === 'restarted' &&
        (!stop ||
          !pause.since ||
          stop.epoch !== pause.since.epoch ||
          stop.sequence < pause.since.sequence))
  )
  const resumable = silent ? null : resumableQueuePause(pauses, journal.queuedMessages.list())
  // The submissions are read only while a pause would show, never while the queue runs freely.
  const pause =
    resumable && !queuePauseLiftOnItsWay(resumable, journal.submissions()) ? resumable : null
  // The test narrows the type.
  const queuePause = pause?.reason === 'stopped' ? { reason: pause.reason } : null
  const nextQueuedMessageId = nextStructuredQueuedMessage({ journal, ...input })?.messageId ?? null
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
