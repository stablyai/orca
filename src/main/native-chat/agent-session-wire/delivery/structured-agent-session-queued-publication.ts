import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuedMessagePausedReason,
  type AgentSessionQueuePause
} from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import {
  queuePauseLiftOnItsWay,
  resumableQueuePause,
  type DerivedQueuePause
} from '../../agent-session-journal/queued-messages/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import type { StructuredQueueGateInput } from './structured-agent-session-queued-gate'
import type { StructuredAgentSessionCurrentWorkHost } from '../observations/structured-agent-session-host-current-work'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { journalSubmissionIsPersonal } from '../../agent-session-journal/submissions/journal-submission-fold'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** Bridge the turn-end/handoff gap with the drain’s next card. */
  nextQueuedMessageId: string | null
}

export type QueueSendGate = (
  journal: AgentSessionJournal,
  cards: readonly QueuedMessageRow[]
) => Promise<
  StructuredQueueGateInput & {
    state: ReturnType<StructuredAgentSessionObservedWork['queueState']>
    selected: QueuedMessageRow | null
  }
>

export function structuredQueueSendGate(
  host: StructuredAgentSessionCurrentWorkHost & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
  },
  sessionId: string,
  now: () => number,
  onWork?: (work: StructuredAgentSessionObservedWork) => void,
  resolved?: StructuredAgentSessionObservedWork
): QueueSendGate {
  return async (journal, cards) => {
    const answer = await journal.readWork(
      () => captureHostStructuredAgentSessionWork(host, sessionId, journal),
      {
        kind: 'input',
        resolved: resolved?.readSource,
        allowSteer: false,
        now: now(),
        facts: journal.queuedMessages.facts(journal.queuedMessages.answerMail(cards))
      }
    )
    const work = new StructuredAgentSessionObservedWork(journal, answer.state, journal.cursor())
    onWork?.(work)
    if ('failure' in answer.queue) {
      throw restoreJournalSqlFailure(answer.queue.failure)
    }
    return {
      record: host.store.getRecord(sessionId),
      authority: captureHostStructuredAgentSessionWork(host, sessionId, journal),
      work,
      state: work.queueState(),
      selected: answer.queue.card
    }
  }
}

/** Waiting and returned rows only. `paused` is a per-card hold (a failed conversion); a person's
 *  Stop pauses the queue, published once beside it. */
function computePublishedQueuedMessages(
  rows: readonly QueuedMessageRow[]
): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of rows) {
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

type ListMemo = {
  key: string
  floor: string
  serialized: string
  list: AgentSessionQueuedMessage[]
  rows: QueuedMessageRow[]
  pauses: DerivedQueuePause[]
}
/** Stable identity avoids repeated serialization on token frames. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()

export function readPublishedQueuedMessages(
  journal: AgentSessionJournal
): Promise<AgentSessionQueuedMessage[]> {
  return journal.readInOrder(async () => (await publishedQueueRows(journal)).list)
}

async function publishedQueueRows(journal: AgentSessionJournal): Promise<ListMemo> {
  const key = journal.queuedMessages.revision()
  const floor = JSON.stringify(journal.reopenFloor())
  const memo = listMemos.get(journal)
  if (memo && memo.key === key && memo.floor === floor) {
    return memo
  }
  const rows = await journal.queuedMessages.list()
  const pauses = await structuredQueuePauses(journal)
  const list = computePublishedQueuedMessages(rows)
  const serialized = JSON.stringify(list)
  const next = {
    key,
    floor,
    serialized,
    list: memo?.serialized === serialized ? memo.list : list,
    rows,
    pauses
  }
  listMemos.set(journal, next)
  return next
}

/** Compare presence first, including unknown reasons. */
export function sameQueuePause(
  previous: { reason?: string } | null,
  next: { reason?: string } | null
): boolean {
  return (previous === null) === (next === null) && previous?.reason === next?.reason
}

export async function readQueuePublication(
  journal: AgentSessionJournal,
  gate: QueueSendGate
): Promise<QueuePublication> {
  return journal.readInOrder(async () => {
    const { rows: cardRows, list: queuedMessages, pauses } = await publishedQueueRows(journal)
    // Show pauses only when Resume can send a card; hide old pauses after clear/reopen.
    const visible = Math.max(
      0,
      ...pauses
        .filter((pause) => pause.reason === 'stopped' || pause.reason === 'failed')
        .map((pause) => pause.since?.sequence ?? 0)
    )
    const silent = pauses.some(
      (pause) =>
        pause.reason === 'cleared' ||
        (pause.reason === 'restarted' &&
          (!visible || !pause.since || visible < pause.since.sequence))
    )
    const personal = { queue: { cards: new Map(cardRows.map((row) => [row.messageId, row])) } }
    const resumable = silent ? null : resumableQueuePause(pauses, cardRows)
    // The input order indexes pending sends, so a held queue never rescans history.
    const input = await gate(journal, cardRows)
    const { state } = input
    const sending = state.owedSendingSubmissions
    const pause =
      resumable &&
      !queuePauseLiftOnItsWay(
        resumable,
        sending,
        (submission) =>
          resumable.reason !== 'stopped' || journalSubmissionIsPersonal(personal, submission)
      )
        ? resumable
        : null
    const working = input.work.activeTurnId() !== null || state.owedEnteredSubmissions.length > 0
    const queuePause =
      pause?.reason === 'stopped' || (pause?.reason === 'failed' && !working)
        ? { reason: pause.reason }
        : null
    const nextQueuedMessageId = input.selected?.messageId ?? null
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
  })
}

/** Closing handles return no claim instead of failing streams/history reads. */
export async function tryReadQueuePublication(
  journal: AgentSessionJournal | undefined,
  gate: QueueSendGate
): Promise<QueuePublication | undefined> {
  try {
    return journal ? await readQueuePublication(journal, gate) : undefined
  } catch {
    return undefined
  }
}
