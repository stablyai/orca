import { isAgentSessionContextClear } from '../../../shared/agent-session/conversation-context/agent-session-context-clear'
import { beforeJournalRequestWrite } from './journal-writer-request-events'
import {
  JOURNAL_DOMAIN_ITEM_COLUMNS,
  journalDomainItemColumns
} from './journal-domain-item-read-columns'
import { journalDomainItemPlacement } from './journal-domain-item-placement'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { journalDomainStopNote, refreshJournalDomainStopNotes } from './journal-domain-stop-notes'
import {
  journalDomainQueueFailure,
  refreshJournalDomainQueueFailureReports
} from './journal-domain-queue-failures'
import { isTurnOrClear, reportedTurnItemId } from './queued-messages/journal-queue-failure-policy'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/requests/structured-agent-session-command-entry'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import { normalizeJournalDomainItemBody } from './journal-domain-item-normalization'
import { observeJournalDomainTurnScope } from './journal-domain-turn-scope'
import {
  observeJournalDomainInputItem,
  refreshJournalDomainAcceptedHandover,
  type JournalDomainInputItemObservation
} from './journal-domain-input-ends'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import { readAgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-body-admission'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import { foldJournalTurnTextTails } from './journal-text-tail'
import { writeJournalDomainItemRow } from './journal-domain-item-row-write'
import {
  hydrateJournalStoredItem,
  journalStoredItemRow,
  readJournalStoredItem
} from './journal-stored-output-rows'

export type JournalDomainCurrentItemWrite = {
  item: AgentJournalRenderItem
  previous?: { item: AgentJournalRenderItem; ordinal: number; hidden: boolean }
  ordinal?: number
  hidden: boolean
  ownerFence: number
  executionOwner?: number | null
  writtenSequence?: number
  stopSettle?: JournalStopSettleFact
  inputObservation?: JournalDomainInputItemObservation
}

function nextJournalDomainItemOrdinal(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): number {
  if (!db.isTransaction) {
    throw new Error('journal item ordinal requires its writer transaction')
  }
  return Number(
    db
      .prepare(`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal
    FROM journal_items WHERE session_id=? AND epoch=?`)
      .get(target.sessionId, target.epoch)!.ordinal
  )
}

/** The owning command chooses revision, placement and authority before its one event append. */
export function writeJournalDomainCurrentItem(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  write: JournalDomainCurrentItemWrite
): AgentJournalRenderItem[] {
  if (!db.isTransaction) {
    throw new Error('journal item persistence requires its writer transaction')
  }
  // A stored form handed back is written from its text, so every derived column stays exact.
  const input = {
    ...write,
    item: hydrateJournalStoredItem(db, [target.sessionId, target.epoch], write.item)
  }
  const body = normalizeJournalDomainItemBody(
    db,
    target,
    input.item,
    input.previous?.item,
    input.stopSettle
  )
  const item = body === input.item.body ? input.item : { ...input.item, body }
  if (readAgentJournalItemBody(item.body) !== 'readable') {
    throw new AgentSessionJournalError(
      'journal_row_rejected',
      `journal item for ${target.sessionId} is not readable`
    )
  }
  if (
    readAgentJournalTurn(item.body) ||
    readAgentJournalTurn(input.previous?.item.body) ||
    isAgentSessionContextClear(item.body)
  ) {
    beforeJournalRequestWrite(db, target, 'turn', item.itemId)
  }
  const prefix = [target.sessionId, target.epoch] as const
  const ordinal =
    input.ordinal ?? input.previous?.ordinal ?? nextJournalDomainItemOrdinal(db, target)
  const stopNote = journalDomainStopNote(item, (id) => {
    if (id === input.item.itemId) {
      return item
    }
    const row = db
      .prepare(`SELECT payload_json FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=COALESCE(
          (SELECT item_id FROM journal_item_aliases
            WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
      .get(...prefix, ...prefix, id, id)
    return row ? readJournalStoredItem(db, prefix, row.payload_json) : undefined
  })
  const next = stopNote.item
  const sequence = input.writtenSequence ?? next.sequence
  const failure = journalDomainQueueFailure(db, target, item, input.previous?.item, sequence)
  const previousReport =
    input.previous && reportedTurnItemId(input.previous.item) !== null
      ? db
          .prepare(`SELECT queue_failure_report_turn_item_id FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=?`)
          .get(...prefix, next.itemId)
      : undefined
  const payload = JSON.stringify(item)
  const columns = journalDomainItemColumns(item, payload, next)
  const { metadata } = columns
  const row = journalStoredItemRow(db, prefix, item, payload, columns.values)
  writeJournalDomainItemRow(db, prefix, next.itemId, [
    ['ordinal', ordinal],
    ['revision', next.revision],
    ['sequence', next.sequence],
    ['sequence_index', next.sequenceIndex ?? 0],
    ['owner_fence', input.ownerFence],
    ['execution_owner', input.executionOwner ?? null],
    ['payload_json', row.payload],
    ['hidden', Number(input.hidden)],
    ['original_stop_note_json', stopNote.originalStopNoteJson],
    ['queue_command_turn', failure.commandTurn],
    ['queue_failed_outcome', failure.failedOutcome],
    ['queue_failed_at', failure.failedAt],
    ['queue_failure_witnessed_through', failure.witnessedThrough],
    ['queue_failure_report_turn_item_id', failure.reportTurnItemId],
    ['placement_json', journalDomainItemPlacement(next)],
    ...JOURNAL_DOMAIN_ITEM_COLUMNS.map((column, index) => [column, row.values[index]] as const),
    // A rewrite of a row whose output is already saved keeps its blob.
    ...(row.keep ? [] : [['output_blob', row.blob] as const])
  ])
  writeJournalDomainItemNames(
    db,
    target,
    next,
    { ordinal, hidden: input.hidden },
    metadata.namedSubagentIds,
    input.previous
  )
  observeJournalDomainTurnScope(db, target, next.itemId, input.previous?.item, next)
  if (input.inputObservation && item.itemId === input.inputObservation.itemId) {
    observeJournalDomainInputItem(db, target, item, input.inputObservation)
  }
  refreshJournalDomainAcceptedHandover(db, target, next.itemId)
  foldJournalTurnTextTails(db, target, next, input.previous?.item)
  const oldReport =
    previousReport?.queue_failure_report_turn_item_id == null
      ? null
      : String(previousReport.queue_failure_report_turn_item_id)
  if (oldReport !== failure.reportTurnItemId || input.previous?.hidden !== input.hidden) {
    refreshJournalDomainQueueFailureReports(
      db,
      target,
      [oldReport, failure.reportTurnItemId],
      sequence
    )
  }
  if (
    isTurnOrClear(next) ||
    isTurnOrClear(input.previous?.item) ||
    next.body.kind === 'approval' ||
    next.body.kind === 'question' ||
    input.previous?.item.body.kind === 'approval' ||
    input.previous?.item.body.kind === 'question' ||
    (metadata.root && next.body.kind === 'message' && next.body.role === 'user') ||
    (input.previous?.item.body.kind === 'message' && input.previous.item.body.role === 'user') ||
    isStructuredAgentSessionCommandEntry(next.body) ||
    isStructuredAgentSessionCommandEntry(input.previous?.item.body) ||
    oldReport !== null ||
    failure.reportTurnItemId !== null
  ) {
    invalidateJournalDomainQueue(db, target, sequence)
  }
  return [
    next,
    ...(readAgentJournalTurn(next.body) || readAgentJournalTurn(input.previous?.item.body)
      ? refreshJournalDomainStopNotes(
          db,
          target,
          [next.itemId],
          new Map([[next.itemId, input.previous?.item]])
        )
      : [])
  ]
}
