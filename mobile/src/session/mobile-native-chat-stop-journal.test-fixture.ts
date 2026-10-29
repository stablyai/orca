// Model a send held through Stop, followed by a never-opened send withdrawn on child exit.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemBody,
  type AgentJournalTurnScope
} from '../../../src/shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import {
  hostJournalFrames,
  type HostJournalFrames
} from './mobile-native-chat-host-journal-frames.test-fixture'

export const STOP_JOURNAL_SESSION = 'codex_session'
export const NEVER_OPENED = 'never-opened'
const THREAD = 'thread-1'
const EPOCH = 'epoch-1'

type RowInput = {
  [K in JournalRow['kind']]: Omit<
    Extract<JournalRow, { kind: K }>,
    'v' | 'epoch' | 'seq' | 'fence' | 'ts'
  >
}[JournalRow['kind']]

// Status-feed Stopping spans use inclusive journal-row bounds.
export type StopJournalStopping = { from: number; until: number }

export type StopJournal = HostJournalFrames & {
  rows: readonly JournalRow[]
  takenBack: number
  neverOpenedSent: number
  stopping: readonly StopJournalStopping[]
}

// Exercise hosts that hold sends until turn end as well as those that write during Stop.
export type SendWhileStoppingWritten = 'after-end' | 'during-turn'

export function stopJournal(
  historyTurns: number,
  sendWhileStopping: SendWhileStoppingWritten = 'after-end'
): StopJournal {
  const rows: JournalRow[] = []
  const stopping: StopJournalStopping[] = []
  let fence = 0
  const add = (row: RowInput): number => {
    const seq = rows.length + 1
    const envelope = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: EPOCH, seq, fence }
    const stamped = { ...row, ...envelope, ts: 1_000 * seq }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `row` is one arm of the union less the envelope, and the envelope added here is the same for every arm.
    rows.push(stamped as JournalRow)
    return seq
  }
  const turnItem = (turnId: string): string =>
    `legacy:codex:${STOP_JOURNAL_SESSION}:turn-lifecycle%3A${turnId}`
  const inTurn = (turnId: string): AgentJournalTurnScope => ({
    kind: 'turn',
    turnItemId: turnItem(turnId)
  })
  const message = (role: 'user' | 'assistant', text: string): AgentJournalItemBody => ({
    kind: 'message',
    role,
    blocks: [{ type: 'text', text }]
  })
  const submit = (id: string): number =>
    add({
      kind: 'submission',
      clientMessageId: id,
      payloadFingerprint: id,
      providerHandle: { kind: 'codex', threadId: THREAD },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      handoverRecorded: true,
      origin: 'client'
    })
  const handOver = (id: string): number =>
    add({
      kind: 'dispatch',
      clientMessageId: id,
      state: 'pending',
      providerItemId: null,
      reason: null,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  const stopEvent = (turnId?: string): number =>
    add({
      kind: 'tombstone',
      itemId: 'orca:stop-event',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1, ...(turnId ? { turnId } : {}) }
    })
  const turnBody = (id: string, turnId: string, state: 'running' | 'completed' | 'interrupted') =>
    ({ kind: 'turn', turnId, state, userItemId: `orca:${id}`, startedAt: 1 }) as const
  const openTurn = (id: string, turnId: string): void => {
    const record = turnItem(turnId)
    const providerKey = `codex:${THREAD}:${turnId}:0`
    const running = { ...turnBody(id, turnId, 'running'), userItemId: providerKey }
    add({
      kind: 'item',
      itemId: record,
      revision: 1,
      body: running,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    add({
      kind: 'item',
      itemId: record,
      revision: 2,
      body: turnBody(id, turnId, 'running'),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    add({
      kind: 'dispatch',
      clientMessageId: id,
      state: 'accepted',
      providerItemId: providerKey,
      reason: null
    })
    add({
      kind: 'item',
      itemId: providerKey,
      revision: 1,
      body: message('user', id),
      turnScope: inTurn(turnId)
    })
    for (const revision of [1, 2, 3]) {
      add({
        kind: 'item',
        itemId: `codex:${THREAD}:${turnId}:1`,
        revision,
        body: message('assistant', `${turnId} part ${revision}`),
        turnScope: inTurn(turnId)
      })
    }
  }
  const endTurn = (id: string, turnId: string, state: 'completed' | 'interrupted'): void => {
    add({
      kind: 'lifecycle-batch',
      settlementId: `turn-completed:${turnId}`,
      mutations: [
        {
          kind: 'item',
          itemId: `codex:${THREAD}:${turnId}:1`,
          revision: 4,
          body: message('assistant', `${turnId} done`),
          turnScope: inTurn(turnId)
        },
        {
          kind: 'item',
          itemId: turnItem(turnId),
          revision: 3,
          body: { ...turnBody(id, turnId, state), completedAt: 2 },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    if (state === 'interrupted') {
      add({
        kind: 'item',
        itemId: `orca:stop%3A${turnId}`,
        revision: 1,
        body: { kind: 'status', text: 'Cancellation requested.' },
        turnScope: inTurn(turnId)
      })
    }
  }

  add({
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: THREAD }
  })
  fence = 1
  for (let index = 0; index < historyTurns; index += 1) {
    const id = `history-${index}`
    const turnId = `t-history-${index}`
    submit(id)
    handOver(id)
    openTurn(id, turnId)
    // Revise/drop provider status both early and near the tail to exercise retained history.
    const revisesStatus = index < 2 || index >= historyTurns - 2
    if (revisesStatus) {
      const progress = `codex:${THREAD}:${turnId}:progress`
      for (const [revision, text] of [
        [1, 'Compacting context'],
        [2, 'Context compacted']
      ] as const) {
        add({
          kind: 'item',
          itemId: progress,
          revision,
          body: { kind: 'status', text },
          turnScope: inTurn(turnId)
        })
      }
      if (index % 2 === 0) {
        add({ kind: 'tombstone', itemId: progress, revision: 3 })
      }
    }
    if (index % 2 === 1) {
      const from = stopEvent(turnId)
      endTurn(id, turnId, 'interrupted')
      stopping.push({ from, until: rows.length })
    } else {
      endTurn(id, turnId, 'completed')
    }
  }
  submit('stopped')
  handOver('stopped')
  openTurn('stopped', 't-stopped')
  const stoppedAt = stopEvent('t-stopped')
  if (sendWhileStopping === 'during-turn') {
    submit('sent-while-stopping')
  }
  endTurn('stopped', 't-stopped', 'interrupted')
  stopping.push({ from: stoppedAt, until: rows.length })
  if (sendWhileStopping === 'after-end') {
    submit('sent-while-stopping')
  }
  handOver('sent-while-stopping')
  openTurn('sent-while-stopping', 't-sent-while-stopping')
  endTurn('sent-while-stopping', 't-sent-while-stopping', 'completed')
  const neverOpenedSent = submit(NEVER_OPENED)
  handOver(NEVER_OPENED)
  const stopNeverOpened = stopEvent()
  const takenBack = add({
    kind: 'dispatch',
    clientMessageId: NEVER_OPENED,
    state: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' },
    recovered: true
  })
  stopping.push({ from: stopNeverOpened, until: takenBack - 1 })
  fence = 2
  submit('recovery')
  handOver('recovery')
  openTurn('recovery', 't-recovery')
  endTurn('recovery', 't-recovery', 'completed')

  return {
    rows,
    takenBack,
    neverOpenedSent,
    stopping,
    ...hostJournalFrames(STOP_JOURNAL_SESSION, EPOCH, rows)
  }
}
