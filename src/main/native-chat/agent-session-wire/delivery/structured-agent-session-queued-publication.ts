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
  queuePauseHolding,
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
import { readJournalSqlWorkAnswerOnce } from '../../agent-session-journal/journal-sql-work-answer'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { captureStructuredMessageSteeringInputs } from '../options/structured-agent-session-message-options'
import { structuredMessageSteeringFallback } from '../../../../shared/agent-session/options/structured-message-steering'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** Bridge the turn-end/handoff gap with the drain’s next card. */
  nextQueuedMessageId: string | null
}

/** Null: live authority no longer matches the work the gate was asked to read at. */
type QueueSendGate = (
  journal: AgentSessionJournal,
  cards: readonly QueuedMessageRow[]
) => Promise<
  | (StructuredQueueGateInput & {
      state: ReturnType<StructuredAgentSessionObservedWork['queueState']>
      selected: QueuedMessageRow | null
      steerFallback: (card: QueuedMessageRow) => AgentSessionQueuedMessage['steerFallback'] | null
    })
  | null
>

export function structuredQueueSendGate(
  host: StructuredAgentSessionCurrentWorkHost & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
    agents: Pick<StructuredAgentRegistry, 'capabilities'>
    adapter: Pick<StructuredAgentSessionAdapter, 'captureMessageSteeringInputs'>
  },
  sessionId: string,
  now: () => number,
  resolved?: StructuredAgentSessionObservedWork
): QueueSendGate {
  return async (journal, cards) => {
    // One attempt, at the resolved frame's own authority when there is one.
    const answer = await readJournalSqlWorkAnswerOnce(
      journal,
      () => captureHostStructuredAgentSessionWork(host, sessionId, journal),
      {
        kind: 'input',
        resolved: resolved?.readSource,
        allowSteer: false,
        now: now(),
        facts: journal.queuedMessages.facts(journal.queuedMessages.answerMail(cards))
      },
      resolved?.readSource?.authority
    )
    if (!answer) {
      return null
    }
    const work = new StructuredAgentSessionObservedWork(journal, answer.state, journal.cursor())
    if ('failure' in answer.queue) {
      throw restoreJournalSqlFailure(answer.queue.failure)
    }
    const record = host.store.getRecord(sessionId)
    const canInject = !!record && host.agents.capabilities(record.provider)?.steering === 'inject'
    const steering = captureStructuredMessageSteeringInputs(
      record,
      host.sessions.get(sessionId)?.child,
      host.adapter
    )
    return {
      record,
      authority: captureHostStructuredAgentSessionWork(host, sessionId, journal),
      work,
      state: work.queueState(),
      selected: answer.queue.card,
      steerFallback: (card) =>
        work.working()
          ? structuredMessageSteeringFallback(canInject, steering, card.options ?? undefined)
          : null
    }
  }
}

/** Restart-held steers need their own Send action because restart pauses have no queue header. */
function computePublishedQueuedMessages(
  rows: readonly QueuedMessageRow[],
  pauses: readonly DerivedQueuePause[]
): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  const restarted = pauses.filter((pause) => pause.reason === 'restarted')
  for (const row of rows) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const held = row.state === 'waiting' && row.holdReason !== null
    const restartHeld = row.deliveryMode === 'steer' && queuePauseHolding(restarted, row)
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(row.deliveryMode ? { deliveryMode: row.deliveryMode } : {}),
      ...(held || restartHeld ? { paused: true as const } : {}),
      // Unknown stored reasons remain plain holds.
      ...(held && isPublishedPausedReason(row.holdReason) ? { pausedReason: row.holdReason } : {}),
      ...(restartHeld ? { pausedReason: 'restarted' as const } : {}),
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
const fallbackMemos = new WeakMap<
  AgentSessionQueuedMessage[],
  { key: string; list: AgentSessionQueuedMessage[] }
>()

function withSteerFallbacks(
  list: AgentSessionQueuedMessage[],
  rows: readonly QueuedMessageRow[],
  fallback: NonNullable<Awaited<ReturnType<QueueSendGate>>>['steerFallback']
): AgentSessionQueuedMessage[] {
  const byId = new Map(rows.map((row) => [row.messageId, row]))
  const reasons = list.map((message) =>
    message.state === 'waiting' &&
    message.deliveryMode === 'steer' &&
    !message.paused &&
    !message.body.command
      ? fallback(byId.get(message.messageId)!)
      : null
  )
  if (reasons.every((reason) => !reason)) {
    return list
  }
  const key = reasons.join(',')
  const memo = fallbackMemos.get(list)
  if (memo?.key === key) {
    return memo.list
  }
  const published = list.map((message, index) =>
    reasons[index] ? { ...message, steerFallback: reasons[index]! } : message
  )
  fallbackMemos.set(list, { key, list: published })
  return published
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
  const list = computePublishedQueuedMessages(rows, pauses)
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
function sameQueuePause(
  previous: { reason?: string } | null,
  next: { reason?: string } | null
): boolean {
  return (previous === null) === (next === null) && previous?.reason === next?.reason
}

/** `inLane`: the caller already holds the chat's command lane, which is not reentrant. Null when
 *  live authority moved during the read. */
export async function readQueuePublication(
  journal: AgentSessionJournal,
  gate: QueueSendGate,
  inLane = false
): Promise<QueuePublication | null> {
  const read = async () => {
    const { rows: cardRows, list, pauses } = await publishedQueueRows(journal)
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
    if (!input) {
      return null
    }
    const queuedMessages = withSteerFallbacks(list, cardRows, input.steerFallback)
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
  }
  return inLane ? read() : journal.readInOrder(read)
}

/** Closing handles return no claim instead of failing streams/history reads. */
export async function tryReadQueuePublication(
  journal: AgentSessionJournal | undefined,
  gate: QueueSendGate,
  inLane = false
): Promise<QueuePublication | null | undefined> {
  try {
    return journal ? await readQueuePublication(journal, gate, inLane) : undefined
  } catch {
    return undefined
  }
}
