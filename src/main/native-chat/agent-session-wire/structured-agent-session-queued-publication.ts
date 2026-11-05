import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuedMessagePausedReason,
  type AgentSessionQueuePause
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { resumableQueuePauseSteps } from '../agent-session-journal/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import {
  nextStructuredQueuedMessage,
  type StructuredQueueGateInput
} from './structured-agent-session-queued-gate'
import {
  heldStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkHost
} from './structured-agent-session-host-current-work'
import { structuredInputHandoverWorkingSteps } from './structured-agent-session-input-selection'

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

/** Waiting and returned rows only. `paused` is a per-card hold (a failed conversion); a person's
 *  Stop pauses the queue, published once beside it. */
function* computePublishedQueuedMessageSteps(
  journal: AgentSessionJournal
): Generator<void, AgentSessionQueuedMessage[]> {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    yield
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

type ListMemo = { key: string; serialized: string[]; list: AgentSessionQueuedMessage[] }
/** Stable identity avoids repeated serialization on token frames. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()

export function readPublishedQueuedMessages(
  journal: AgentSessionJournal
): AgentSessionQueuedMessage[] {
  return finishJournalSteps(readPublishedQueuedMessageSteps(journal))
}

export function* readPublishedQueuedMessageSteps(
  journal: AgentSessionJournal
): Generator<void, AgentSessionQueuedMessage[]> {
  const key = journal.queuedMessages.revision()
  const memo = listMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = yield* computePublishedQueuedMessageSteps(journal)
  const serialized: string[] = []
  let same = memo?.list.length === list.length
  for (let index = 0; index < list.length; index++) {
    const row = JSON.stringify(list[index])
    serialized.push(row)
    same &&= memo?.serialized[index] === row
    yield
  }
  if (memo && same) {
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
  return finishJournalSteps(readQueuePublicationSteps(journal, gate))
}

export function* readQueuePublicationSteps(
  journal: AgentSessionJournal,
  gate: QueueSendGate
): Generator<void, QueuePublication> {
  const queuedMessages = yield* readPublishedQueuedMessageSteps(journal)
  // Show pauses only when Resume can send a card; hide old pauses after clear/reopen.
  // Re-derive per emit because submission acceptance can lift a pause.
  const pauses = structuredQueuePauses(journal)
  const visible = Math.max(
    0,
    ...pauses
      .filter((pause) => pause.reason === 'stopped' || pause.reason === 'failed')
      .map((pause) => pause.since?.sequence ?? 0)
  )
  const silent = pauses.some(
    (pause) =>
      pause.reason === 'cleared' ||
      (pause.reason === 'restarted' && (!visible || !pause.since || visible < pause.since.sequence))
  )
  const resumable =
    silent || pauses.length === 0
      ? null
      : yield* resumableQueuePauseSteps(pauses, journal.queuedMessages.list())
  // The input order indexes pending sends, so a held queue never rescans history.
  const input = gate(journal)
  let lifting = false
  if (resumable) {
    const anchor = resumable.since?.sequence ?? 0
    for (const submission of journal.inputOrder.sendingSubmissionValues()) {
      if (
        submission.dispatchState === 'pending' &&
        (submission.acceptedSequence ?? 0) > anchor &&
        input.work.owesSend(submission)
      ) {
        lifting = true
        break
      }
      yield
    }
  }
  const pause = lifting ? null : resumable
  const working =
    input.work.activeTurnId() !== null ||
    (yield* structuredInputHandoverWorkingSteps(journal, input.work))
  yield* input.work.actionablePromptSteps(() => true)
  const queuePause =
    pause?.reason === 'stopped' || (pause?.reason === 'failed' && !working)
      ? { reason: pause.reason }
      : null
  const nextQueuedMessageId =
    nextStructuredQueuedMessage({ journal, ...input, working })?.messageId ?? null
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

export function queuePublicationReaders(
  sessions: StructuredAgentSessionCurrentWorkHost['sessions'],
  store: () => AgentSessionRecordStore
) {
  return {
    readQueuePublication: (id: string) =>
      tryReadQueuePublication(
        sessions.get(id)?.journal,
        structuredQueueSendGate({ store: store(), sessions }, id)
      ),
    readQueuePublicationSteps: function* (
      id: string
    ): Generator<void, QueuePublication | undefined> {
      const journal = sessions.get(id)?.journal
      if (!journal) {
        return undefined
      }
      return yield* readQueuePublicationSteps(
        journal,
        structuredQueueSendGate({ store: store(), sessions }, id)
      )
    }
  }
}
