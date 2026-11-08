import type Database from '../../sqlite/sync-database'
import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session/agent-session-provider-context'
import { applyJournalDomainItem } from './journal-domain-item'
import {
  SELECT_JOURNAL_DOMAIN_QUEUE_ROW,
  readJournalDomainQueueRow,
  replaceJournalDomainQueueRow
} from './journal-domain-queue-rows'
import {
  journalDomainEditLeaseDeadline,
  retireJournalDomainEditHolds
} from './journal-domain-edit-leases'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import {
  journalDomainPublicCursor,
  replaceJournalDomainContext,
  type JournalDomainContextCommit,
  type JournalDomainContextReplacement
} from './journal-domain-context-replacement'
import { writeJournalDomainQueueClear } from './journal-domain-queue-clear'

type Target = { sessionId: string; epoch: string }

export type JournalDomainContextOperation =
  | { kind: 'context-clear'; boundary: AgentSessionProviderContextBoundary }
  | JournalDomainContextReplacement

/** Runs only on the owning writer connection, inside its command SAVEPOINT. */
export function applyJournalDomainContextCommand(
  db: Database.Database,
  target: Target,
  operation: JournalDomainContextOperation,
  savedAt: number
): JournalDomainContextCommit {
  if (!db.isTransaction) {
    throw new Error('journal context command requires its writer transaction')
  }
  return operation.kind === 'context-clear'
    ? clearJournalDomainContext(db, target, operation.boundary, savedAt)
    : replaceJournalDomainContext(db, target, operation, savedAt)
}

function clearJournalDomainContext(
  db: Database.Database,
  target: Target,
  boundary: AgentSessionProviderContextBoundary,
  savedAt: number
): JournalDomainContextCommit {
  const fence = boundary.afterFence
  const divider = applyJournalDomainItem(
    db,
    target,
    {
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: `context-clear:${boundary.operationId}` },
      body: {
        kind: 'status',
        text: 'Context cleared',
        presentation: 'context-cleared',
        contextClear: boundary
      },
      options: { fence, turnScope: { kind: 'thread' } }
    },
    savedAt
  )
  const sequence = divider.cursor.sequence + 1
  const unsettled = db
    .prepare(`${SELECT_JOURNAL_DOMAIN_QUEUE_ROW} WHERE session_id=? AND epoch=?
      AND state IN ('waiting','returned') ORDER BY position, message_id`)
    .all(target.sessionId, target.epoch)
    .map((row) => readJournalDomainQueueRow(target.sessionId, row))
  // Commands belong to the ended context and must move with its divider.
  const withdrawn = unsettled.flatMap((prior) => {
    if (!prior.card.body.command) {
      return []
    }
    const card = { ...prior.card, state: 'withdrawn' as const, holdReason: null }
    replaceJournalDomainQueueRow(db, target, prior, card)
    return [card]
  })
  const clear = writeJournalDomainQueueClear(db, target, sequence, {
    operationId: boundary.operationId,
    messageIds: unsettled
      .filter(({ card }) => card.state === 'waiting' && !card.body.command)
      .map(({ card }) => card.messageId)
  })
  const commit: JournalDomainContextCommit = {
    cursor: { epoch: '', sequence },
    physicalCursor: { epoch: target.epoch, sequence },
    contextBoundary: null,
    coordinates: [
      { kind: 'context-item', cursor: divider.cursor, fence, observedAt: savedAt },
      {
        kind: 'queue-clear',
        cursor: { epoch: target.epoch, sequence },
        fence,
        observedAt: savedAt
      }
    ],
    items: divider.items,
    removedItemIds: [],
    removedTurnIds: [],
    cards: [...divider.cards, ...withdrawn],
    clear,
    receipts: divider.receipts,
    inputChanged: true,
    ...(divider.acceptedInputs ? { acceptedInputs: divider.acceptedInputs } : {}),
    ...(divider.editDeadline !== undefined ? { editDeadline: divider.editDeadline } : {})
  }
  if (
    retireJournalDomainEditHolds(
      db,
      target,
      withdrawn.map((card) => card.messageId)
    )
  ) {
    commit.editDeadline = journalDomainEditLeaseDeadline(db, target, savedAt)
  }
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    {
      items: [],
      submissions: [],
      cards: [...new Set([...withdrawn.map((card) => card.messageId), ...clear.messageIds])]
    },
    { fence, observedAt: savedAt }
  )
  commit.cursor = journalDomainPublicCursor(db, target, sequence)
  return commit
}
