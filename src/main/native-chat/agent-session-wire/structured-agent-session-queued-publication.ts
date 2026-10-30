// Publish list/pause/next-card together with stable identity so token frames cannot resend unchanged queues.

import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuedMessagePausedReason,
  type AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  queuePauseLiftOnItsWay,
  resumableQueuePause
} from '../agent-session-journal/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import {
  nextStructuredQueuedMessage,
  structuredQueueHold,
  type StructuredQueueGateInput
} from './structured-agent-session-queued-messages'
import {
  heldStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkHost
} from './structured-agent-session-host-current-work'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** Bridge the turn-end/handoff gap with the drain’s next card. */
  nextQueuedMessageId: string | null
}

export type QueueSendGate = (journal: AgentSessionJournal) => StructuredQueueGateInput

export function structuredQueueSendGate(
  host: StructuredAgentSessionCurrentWorkHost & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
  },
  sessionId: string
): QueueSendGate {
  return (journal) => ({
    record: host.store.getRecord(sessionId),
    work: heldStructuredAgentSessionCurrentWork(
      host.store,
      sessionId,
      journal,
      host.sessions.get(sessionId)
    )
  })
}

/** Per-card holds are separate from the queue-level Stop pause published beside the list. */
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
      // Unknown stored reasons remain plain holds.
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
  return reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
}

type ListMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Stable identity avoids repeated serialization on token frames. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()
const publicationKeys = new WeakMap<AgentSessionJournal, string>()

function readPublishedQueuedMessages(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  const key = JSON.stringify([journal.queuedMessages.revision(), journal.mailHoldFacts().key])
  const memo = listMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = computePublishedQueuedMessages(journal)
  // Equal recomputed content must retain identity for subscriber deduplication.
  const serialized = JSON.stringify(list)
  if (memo && memo.serialized === serialized) {
    listMemos.set(journal, { key, serialized, list: memo.list })
    return memo.list
  }
  listMemos.set(journal, { key, serialized, list })
  return list
}

/** Compare presence first, including unknown reasons. */
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
  const hold = input.work.working() ? 'working' : structuredQueueHold(input)
  const key = JSON.stringify([
    journal.queuedMessages.selectionRevision(),
    journal.mailHoldFacts().key,
    hold
  ])
  const cached = publications.get(journal)
  if (cached && publicationKeys.get(journal) === key) {
    return cached
  }
  publicationKeys.set(journal, key)
  const queuedMessages = readPublishedQueuedMessages(journal)
  const rows = journal.queuedMessages.list()
  const pauses = structuredQueuePauses(journal)
  const resumable = resumableQueuePause(pauses, rows)
  const heldReport = rows.some(
    (row) =>
      row.state === 'waiting' &&
      row.holdReason === null &&
      row.body.from?.orchestration?.message === 'mail-notice' &&
      !journal.queuedMessages.mailEligible(row)
  )
  const intent = journal.mailBoundary()
  const humanPending = journal
    .submissions()
    .filter(
      (row) =>
        row.origin === 'client' ||
        (intent?.status === 'released' &&
          intent.at.epoch === journal.epoch &&
          intent.at.sequence === row.acceptedSequence)
    )
  const ordinaryPause =
    resumable?.reason === 'stopped' &&
    !pauses.some((pause) => pause.reason === 'restarted') &&
    !queuePauseLiftOnItsWay(resumable, humanPending, () => true)
  const queuePause = heldReport || ordinaryPause ? { reason: 'stopped' as const } : null
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

/** Closing handles return no claim instead of failing streams/history reads. */
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
