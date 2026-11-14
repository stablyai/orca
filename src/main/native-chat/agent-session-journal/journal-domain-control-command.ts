import { JOURNAL_STOP_EVENT_ITEM_ID } from './context-epochs/journal-stop-and-resume-rows'
import type Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { JournalWriterOperation } from './journal-writer-command'
import type { JournalWriterCoordinate } from './journal-writer-effects'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalAppendResult, JournalStopAcceptance } from './journal-store-contracts'
import type { JournalStopEvent } from './durable-rows/journal-row-schema'
import {
  foldJournalQueuePauseMark,
  journalManualStop,
  type JournalQueuePauseMarks
} from './queued-messages/queued-message-pause-marks'
import { journalRowBase } from './writing/journal-row-builders'
import { assertJournalFence } from './writing/journal-write-guards'
import type { JournalDomainSubmissionCommit } from './journal-domain-submission-records'
import type { JournalDomainInputCoordinate } from './journal-domain-input-commit'
import { applyJournalDomainInputRecovery } from './journal-domain-input-recovery'
import { applyJournalDomainItem } from './journal-domain-item'
import { observeJournalDomainInputStop } from './journal-domain-input-ends'
import { writeJournalDomainQueueReopenMark } from './journal-domain-queue-pauses'
import {
  journalDomainQueueAwaitsReopen,
  readJournalDomainQueuePauses
} from './journal-domain-queue-reads'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { restoreJournalSqlFailure } from './journal-sql-failure'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

type Target = { sessionId: string; epoch: string }

export type JournalDomainControlOperation = Extract<
  JournalWriterOperation,
  {
    kind:
      | 'stop'
      | 'stop-accept'
      | 'queue-resume'
      | 'queue-reopen'
      | 'queue-reopen-mark'
      | 'shutdown-cut'
  }
>

export type JournalDomainControlValue =
  | AgentJournalCursor
  | JournalStopAcceptance
  | JournalAppendResult
  | number
  | null

/** Coordinates are physical; an empty list means the legacy no-op bound no receipt. */
export type JournalDomainControlCommit = Omit<
  JournalDomainSubmissionCommit<JournalDomainControlValue>,
  'coordinates'
> & { coordinates: JournalWriterCoordinate[] }

// Host-held sends prove non-delivery.
const STOP_WITHDRAWAL = agentSessionFailureWords(
  agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
  { surface: 'rejection' }
)

/** Decides each control mark against current head rows at its writer position. */
export function applyJournalDomainControlCommand(
  db: Database.Database,
  target: Target,
  operation: JournalDomainControlOperation,
  facts: { stopSettle?: JournalStopSettleFact; reopenFloor?: AgentJournalCursor | null },
  savedAt: number
): JournalDomainControlCommit {
  if (!db.isTransaction) {
    throw new Error('journal control command requires its writer transaction')
  }
  const head = db
    .prepare(`SELECT last_sequence, highest_fence FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal control command targets a retired chat epoch')
  }
  const result: JournalDomainControlCommit = {
    cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
    value: null,
    coordinates: [],
    items: [],
    removedItemIds: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  switch (operation.kind) {
    case 'shutdown-cut':
      return appendShutdownCut(db, target, operation.input, facts, savedAt, result)
    case 'queue-reopen-mark':
      // Nothing awaits reopening: no mark, event or receipt row.
      if (!journalDomainQueueAwaitsReopen(db, target)) {
        return result
      }
      break
    case 'stop':
    case 'stop-accept':
    case 'queue-resume':
    case 'queue-reopen':
      break
  }
  assertJournalFence(operation.fence, Number(head.highest_fence))
  switch (operation.kind) {
    case 'stop':
      result.value = writeMark(db, target, operation.fence, savedAt, result, (sequence) =>
        writeStop(db, target, sequence, operation.fence, { ...operation.event, at: savedAt })
      )
      return result
    case 'stop-accept':
      return acceptStop(db, target, operation, savedAt, result)
    case 'queue-resume':
      if (operation.onlyRestarted) {
        const pauses = readJournalDomainQueuePauses(db, target, facts.reopenFloor ?? null)
        if (pauses.length === 0 || pauses.some((pause) => pause.reason !== 'restarted')) {
          return result
        }
      }
      result.value = writeMark(db, target, operation.fence, savedAt, result, (sequence) => {
        db.prepare(`UPDATE journal_chat_state SET queue_resumed_sequence=?
          WHERE session_id=? AND epoch=?`).run(sequence, target.sessionId, target.epoch)
      })
      return result
    case 'queue-reopen':
    case 'queue-reopen-mark': {
      const cursor = writeMark(db, target, operation.fence, savedAt, result, (sequence) =>
        writeJournalDomainQueueReopenMark(db, target, sequence, operation.since ?? sequence)
      )
      result.value =
        operation.kind === 'queue-reopen' ? cursor : (operation.since ?? cursor.sequence)
      return result
    }
  }
}

/** Withdrawals and the Stop share one rollback: a failed acceptance interrupts nothing. */
function acceptStop(
  db: Database.Database,
  target: Target,
  operation: Extract<JournalDomainControlOperation, { kind: 'stop-accept' }>,
  savedAt: number,
  result: JournalDomainControlCommit
): JournalDomainControlCommit {
  const turnId = operation.event.turnId ?? operation.liveTurnId
  const withdrawals = applyJournalDomainInputRecovery(
    db,
    target,
    { kind: 'queued-reject', fence: operation.fence, rejection: STOP_WITHDRAWAL },
    {},
    savedAt
  )
  const { value: settled, coordinates, ...publication } = withdrawals
  if ('failure' in settled) {
    throw restoreJournalSqlFailure(settled.failure)
  }
  Object.assign(result, publication)
  result.coordinates.push(...coordinates.map((position) => physicalCoordinate(position)))
  const event: JournalStopEvent = {
    ...operation.event,
    ...(turnId !== null ? { turnId } : {}),
    at: savedAt
  }
  const mark = writeMark(db, target, operation.fence, savedAt, result, (sequence) =>
    writeStop(db, target, sequence, operation.fence, event)
  )
  result.value = { mark, withdrawn: Array.isArray(settled.value) ? settled.value : [], turnId }
  return result
}

/** One event-only head mark; the receipt binds this command's last coordinate. */
function writeMark(
  db: Database.Database,
  target: Target,
  fence: number,
  savedAt: number,
  result: JournalDomainControlCommit,
  write: (sequence: number) => void
): AgentJournalCursor {
  const sequence = result.cursor.sequence + 1
  write(sequence)
  invalidateJournalDomainQueue(db, target, sequence)
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    { items: [], submissions: [], cards: [] },
    { fence, observedAt: savedAt }
  )
  result.cursor = { epoch: target.epoch, sequence }
  result.coordinates.push({ kind: 'tombstone', epoch: target.epoch, seq: sequence })
  result.inputChanged = true
  return result.cursor
}

/** Saved marks only; the host's unsaved settle overlay never reaches the head. */
function writeStop(
  db: Database.Database,
  target: Target,
  sequence: number,
  fence: number,
  event: JournalStopEvent
): void {
  const head = db
    .prepare(`SELECT queue_latest_stop_json, queue_manual_stop_json FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)!
  const marks: JournalQueuePauseMarks = {
    latestStop:
      head.queue_latest_stop_json === null ? null : JSON.parse(String(head.queue_latest_stop_json)),
    resumedSequence: 0,
    reopenedSequence: 0
  }
  // An older layout's manual Stop is materialized before this write, as the format-3 writer does.
  const stop: JournalQueuePauseMarks['latestStop'] =
    head.queue_manual_stop_json === null
      ? journalManualStop(marks)
      : JSON.parse(String(head.queue_manual_stop_json))
  marks.manualStop = stop && {
    sequence: stop.sequence,
    event: { ...stop.event, reason: 'user-stop' }
  }
  foldJournalQueuePauseMark(marks, {
    kind: 'tombstone',
    itemId: JOURNAL_STOP_EVENT_ITEM_ID,
    revision: 1,
    stopEvent: event,
    ...journalRowBase(target.epoch, sequence, fence, event.at)
  })
  db.prepare(`UPDATE journal_chat_state SET queue_latest_stop_json=?, queue_manual_stop_json=?
    WHERE session_id=? AND epoch=?`).run(
    JSON.stringify(marks.latestStop),
    JSON.stringify(marks.manualStop),
    target.sessionId,
    target.epoch
  )
  observeJournalDomainInputStop(db, target, JOURNAL_STOP_EVENT_ITEM_ID, sequence, fence, event)
}

/** Quit explains only a presented interrupted turn; an existing cut writes nothing. */
function appendShutdownCut(
  db: Database.Database,
  target: Target,
  input: Extract<JournalDomainControlOperation, { kind: 'shutdown-cut' }>['input'],
  facts: { stopSettle?: JournalStopSettleFact },
  savedAt: number,
  result: JournalDomainControlCommit
): JournalDomainControlCommit {
  const itemId = agentJournalItemKey(input.identity)
  const turn = readAgentJournalTurn(visibleItem(db, target, input.turnItemId)?.body)
  if (
    visibleItem(db, target, itemId) ||
    !turn ||
    agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) !==
      'interruption'
  ) {
    return result
  }
  const written = applyJournalDomainItem(
    db,
    target,
    {
      kind: 'item',
      identity: input.identity,
      body: input.body,
      options: { fence: input.fence, turnScope: { kind: 'turn', turnItemId: input.turnItemId } }
    },
    savedAt,
    facts.stopSettle
  )
  const { outcome: _outcome, publicCursor: _public, ...publication } = written
  Object.assign(result, publication)
  const item = written.items.find((entry) => entry.itemId === itemId) ?? written.items[0]!
  result.coordinates.push({ kind: 'item', epoch: target.epoch, seq: written.cursor.sequence })
  result.value = { cursor: written.cursor, itemId, revision: item.revision }
  return result
}

function visibleItem(
  db: Database.Database,
  target: Target,
  key: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=COALESCE((SELECT item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
    .get(target.sessionId, target.epoch, target.sessionId, target.epoch, key, key)
  return row ? JSON.parse(String(row.payload_json)) : null
}

function physicalCoordinate(position: JournalDomainInputCoordinate): JournalWriterCoordinate {
  return {
    kind:
      position.kind === 'queue-reopen'
        ? 'tombstone'
        : position.kind === 'command-settle'
          ? 'lifecycle-batch'
          : position.kind,
    epoch: position.cursor.epoch,
    seq: position.cursor.sequence
  }
}
