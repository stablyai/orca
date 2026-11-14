import type Database from '../../sqlite/sync-database'
import { recordSystemMailWithdrawal } from './writing/mail-withdrawal-receipts'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type {
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import {
  journalDomainEditLeaseDeadline,
  retireJournalDomainEditHolds
} from './journal-domain-edit-leases'
import {
  holdJournalDomainQueueRow,
  insertJournalDomainQueueRow,
  journalDomainQueueRow,
  placeJournalDomainQueueRow,
  replaceJournalDomainQueueRow,
  type JournalDomainQueueRow
} from './journal-domain-queue-rows'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import type { JournalSqlQueueWrite } from './journal-sql-queued-messages'
import { queuedMessageMovePlan } from './queued-messages/queued-message-move'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from './queued-messages/queued-message-table'
import { queuedMessageUpdateDecision } from './queued-messages/queued-message-update'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

type Target = { sessionId: string; epoch: string }

export type JournalDomainQueueOperation = JournalSqlQueueWrite

export type JournalDomainQueueResult =
  | { kind: 'queue-insert'; card: QueuedMessageRow }
  | { kind: 'queue-update'; update: AgentSessionQueuedMessageUpdateResult }
  | { kind: 'queue-hold' }
  | { kind: 'queue-withdraw'; cards: QueuedMessageRow[] }
  | { kind: 'queue-move'; move: AgentSessionQueuedMessageMoveResult }

export type JournalDomainQueuePlacement = { messageId: string; position: number }

export type JournalDomainQueueCommit = {
  cursor: AgentJournalCursor
  result: JournalDomainQueueResult
  cards: QueuedMessageRow[]
  insertedCardIds: string[]
  /** A move changes only these positions; card content stays as last published. */
  placements: JournalDomainQueuePlacement[]
  inputChanged: boolean
  /** Present only when this command retired edit leases. */
  editDeadline?: number | null
  /** Uploads this card now references; the host releases their goal inverse after COMMIT. */
  referencedUploads?: string[]
}

type Change = {
  prior: JournalDomainQueueRow | null
  card: QueuedMessageRow
  /** Hold reasons are neither content nor state, so they keep edit holds. */
  holdOnly?: boolean
}

/** Runs only on the owning writer connection, inside its command transaction or SAVEPOINT. */
export function applyJournalDomainQueueCommand(
  db: Database.Database,
  stateDirectory: string,
  target: Target,
  operation: JournalDomainQueueOperation,
  savedAt: number
): JournalDomainQueueCommit {
  if (!db.isTransaction) {
    throw new Error('journal queue command requires its writer transaction')
  }
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal queue command targets a retired chat epoch')
  }
  const cursor = { epoch: target.epoch, sequence: Number(head.last_sequence) }
  const current = (messageId: string) => journalDomainQueueRow(db, target, messageId)
  const claim = (
    body: AgentJournalMessageItem,
    required: boolean,
    previous?: AgentJournalMessageItem
  ) => [
    ...claimAgentSessionAttachmentsInTransaction(db, {
      stateDirectory,
      sessionId: target.sessionId,
      body,
      required,
      ...(previous ? { previous } : {}),
      now: savedAt
    }).referenced
  ]
  let result: JournalDomainQueueResult
  let changes: Change[] = []
  let placements: JournalDomainQueuePlacement[] = []
  let retire: string[] = []
  let referencedUploads: string[] | undefined
  switch (operation.kind) {
    case 'queue-insert': {
      const { input } = operation
      const existing = current(input.messageId)
      // An existing ID is duplicate admission of the same accepted card, never new queue work.
      if (existing) {
        result = { kind: 'queue-insert', card: existing.card }
        break
      }
      referencedUploads = claim(input.body, input.requireAttachments === true)
      const last = db
        .prepare(`SELECT MAX(position) AS position FROM journal_queue_cards
          WHERE session_id=? AND epoch=?`)
        .get(target.sessionId, target.epoch)
      const options = readAgentSessionExecutionOptions(input.options)
      const card: QueuedMessageRow = {
        messageId: input.messageId,
        position: Math.max(0, Number(last?.position ?? 0)) + 1,
        body: input.body,
        fingerprint: agentSessionSendBodyFingerprint(target.sessionId, input.body),
        state: 'waiting',
        holdReason: input.holdReason ?? null,
        returnedReason: null,
        returnedRejection: null,
        consumedAs: null,
        queuedAt: cursor,
        ...(options ? { options } : {}),
        ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
        ...(input.unattended !== undefined ? { unattended: input.unattended } : {})
      }
      changes = [{ prior: null, card }]
      result = { kind: 'queue-insert', card }
      break
    }
    case 'queue-update': {
      const { input } = operation
      const prior = current(input.messageId)
      const decision = queuedMessageUpdateDecision(prior?.card ?? null, target.sessionId, input)
      // Any answer ends the edit that held this card, as the edit-lease owner does today.
      retire = [input.messageId]
      if (decision.status !== 'ready') {
        result = { kind: 'queue-update', update: decision }
        break
      }
      referencedUploads = claim(decision.body, true, decision.previous)
      changes = [
        { prior, card: { ...prior!.card, body: decision.body, fingerprint: decision.fingerprint } }
      ]
      result = {
        kind: 'queue-update',
        update: {
          status: 'updated',
          messageId: input.messageId,
          fingerprint: decision.fingerprint
        }
      }
      break
    }
    case 'queue-hold':
      changes = addressed(operation.messageIds, current).flatMap((prior) =>
        prior.card.state === 'waiting' && prior.card.holdReason !== operation.reason
          ? [{ prior, card: { ...prior.card, holdReason: operation.reason }, holdOnly: true }]
          : []
      )
      result = { kind: 'queue-hold' }
      break
    case 'queue-withdraw':
      changes = addressed(operation.messageIds, current).flatMap((prior) =>
        isUnsettledQueuedMessage(prior.card)
          ? [{ prior, card: { ...prior.card, state: 'withdrawn' as const, holdReason: null } }]
          : []
      )
      retire = changes.map(({ card }) => card.messageId)
      result = { kind: 'queue-withdraw', cards: changes.map(({ card }) => card) }
      break
    case 'queue-move': {
      // Only a move reads the ordered unsettled headers; dispatched cards keep their reserved slots.
      const unsettled = db
        .prepare(`SELECT message_id, state, position FROM journal_queue_cards
          WHERE session_id=? AND epoch=? AND state IN ('waiting','returned')
          ORDER BY position, message_id`)
        .all(target.sessionId, target.epoch)
        .map((row) => ({
          messageId: String(row.message_id),
          state: row.state === 'returned' ? ('returned' as const) : ('waiting' as const),
          position: Number(row.position)
        }))
      const plan = queuedMessageMovePlan(unsettled, operation.input)
      placements = plan.changes.flatMap(({ messageId, change }) =>
        change?.op === 'moved' ? [{ messageId, position: change.position }] : []
      )
      result = { kind: 'queue-move', move: plan.result }
      break
    }
  }
  const commit: JournalDomainQueueCommit = {
    cursor,
    result,
    cards: changes.map(({ card }) => card),
    insertedCardIds: changes
      .filter(({ prior }) => prior === null)
      .map(({ card }) => card.messageId),
    placements,
    inputChanged: changes.length > 0 || placements.length > 0,
    ...(referencedUploads?.length ? { referencedUploads } : {})
  }
  const sequence = cursor.sequence + 1
  for (const { prior, card, holdOnly } of changes) {
    if (!prior) {
      insertJournalDomainQueueRow(db, target, card)
    } else if (holdOnly) {
      holdJournalDomainQueueRow(db, target, prior, card.holdReason)
    } else {
      replaceJournalDomainQueueRow(db, target, prior, card)
    }
    if (operation.kind === 'queue-withdraw' && operation.systemMail) {
      recordSystemMailWithdrawal(db, target, card, savedAt)
    }
  }
  for (const { messageId, position } of placements) {
    placeJournalDomainQueueRow(db, target, messageId, position)
  }
  retireHolds(db, target, retire, commit, savedAt)
  if (!commit.inputChanged) {
    return commit
  }
  appendJournalSqlEvent(db, target, sequence, savedAt, {
    items: [],
    submissions: [],
    cards: [...commit.cards, ...placements].map((card) => card.messageId)
  })
  commit.cursor = { epoch: target.epoch, sequence }
  return commit
}

function retireHolds(
  db: Database.Database,
  target: Target,
  messageIds: readonly string[],
  commit: JournalDomainQueueCommit,
  now: number
): void {
  if (retireJournalDomainEditHolds(db, target, messageIds)) {
    invalidateJournalDomainQueue(db, target)
    commit.inputChanged = true
    commit.editDeadline = journalDomainEditLeaseDeadline(db, target, now)
  }
}

/** Each addressed card at most once, in the caller's order. */
function addressed(
  messageIds: readonly string[],
  current: (messageId: string) => JournalDomainQueueRow | null
): JournalDomainQueueRow[] {
  return [...new Set(messageIds)].flatMap((messageId) => {
    const card = current(messageId)
    return card ? [card] : []
  })
}
