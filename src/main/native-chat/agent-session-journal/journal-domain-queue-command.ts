import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type {
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainEditLease } from './journal-domain-edit-leases'
import {
  journalDomainCurrentCard,
  readJournalDomainCard,
  SELECT_JOURNAL_DOMAIN_CARD,
  writeJournalDomainCardVersion,
  type JournalDomainCard
} from './journal-domain-card-versions'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import type { JournalSqlQueueWrite } from './journal-sql-queued-messages'
import { queuedMessageMovePlan } from './queued-messages/queued-message-move'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from './queued-messages/queued-message-table'
import { queuedMessageUpdateDecision } from './queued-messages/queued-message-update'

type Target = { sessionId: string; epoch: string }

export type JournalDomainQueueOperation = JournalSqlQueueWrite

export type JournalDomainQueueResult =
  | { kind: 'queue-insert'; card: QueuedMessageRow }
  | { kind: 'queue-update'; update: AgentSessionQueuedMessageUpdateResult }
  | { kind: 'queue-hold' }
  | { kind: 'queue-withdraw'; cards: QueuedMessageRow[] }
  | { kind: 'queue-move'; move: AgentSessionQueuedMessageMoveResult }

export type JournalDomainQueueCommit = {
  cursor: AgentJournalCursor
  result: JournalDomainQueueResult
  cards: QueuedMessageRow[]
  inputChanged: boolean
  /** Present only when this command retired edit leases. */
  editDeadline?: number | null
  /** Uploads this card now references; the host releases their goal inverse after COMMIT. */
  referencedUploads?: string[]
}

type Change = { prior: JournalDomainCard | null; card: QueuedMessageRow }

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
  const current = (messageId: string) => journalDomainCurrentCard(db, target, messageId)
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
        .prepare(`SELECT MAX(position) AS position FROM journal_card_versions
          WHERE session_id=? AND epoch=? AND current=1`)
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
          ? [{ prior, card: { ...prior.card, holdReason: operation.reason } }]
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
      // Only a move reads the ordered unsettled set; dispatched cards keep their reserved slots.
      const unsettled = db
        .prepare(`${SELECT_JOURNAL_DOMAIN_CARD} WHERE session_id=? AND epoch=? AND current=1
          AND state IN ('waiting','returned') ORDER BY position, message_id`)
        .all(target.sessionId, target.epoch)
        .map((row) => readJournalDomainCard(target.sessionId, row))
      const plan = queuedMessageMovePlan(
        unsettled.map(({ card }) => card),
        operation.input
      )
      changes = plan.changes.flatMap(({ messageId, change }) => {
        const prior = unsettled.find(({ card }) => card.messageId === messageId)
        return prior && change?.op === 'moved'
          ? [{ prior, card: { ...prior.card, position: change.position } }]
          : []
      })
      result = { kind: 'queue-move', move: plan.result }
      break
    }
  }
  const commit: JournalDomainQueueCommit = {
    cursor,
    result,
    cards: changes.map(({ card }) => card),
    inputChanged: changes.length > 0,
    ...(referencedUploads?.length ? { referencedUploads } : {})
  }
  let leasesChanged = false
  let editDeadline: number | null = null
  for (const messageId of retire) {
    const retired = applyJournalDomainEditLease(
      db,
      target,
      '',
      { kind: 'retire-card', messageId },
      savedAt
    )
    leasesChanged ||= retired.changed
    editDeadline = retired.nextDeadline
  }
  if (leasesChanged) {
    commit.editDeadline = editDeadline
  }
  if (changes.length === 0) {
    return commit
  }
  const sequence = cursor.sequence + 1
  for (const { prior, card } of changes) {
    writeJournalDomainCardVersion(db, target, prior, card, sequence)
  }
  db.prepare('UPDATE journal_chat_state SET last_sequence=? WHERE session_id=? AND epoch=?').run(
    sequence,
    target.sessionId,
    target.epoch
  )
  appendJournalSqlEvent(db, target, sequence, savedAt, {
    items: [],
    submissions: [],
    cards: commit.cards.map((card) => card.messageId)
  })
  commit.cursor = { epoch: target.epoch, sequence }
  return commit
}

/** Each addressed card at most once, in the caller's order. */
function addressed(
  messageIds: readonly string[],
  current: (messageId: string) => JournalDomainCard | null
): JournalDomainCard[] {
  return [...new Set(messageIds)].flatMap((messageId) => {
    const card = current(messageId)
    return card ? [card] : []
  })
}
