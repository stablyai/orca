import type Database from '../../sqlite/sync-database'
import {
  applyJournalDomainItem,
  type JournalDomainItemWrite,
  type JournalDomainItemCommit
} from './journal-domain-item'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStepOutcome } from './writing/journal-writer-step'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'

export type JournalSqlMessage = JournalDomainItemWrite & { body: AgentJournalMessageItem }

type MessageCommand = {
  target: { sessionId: string; epoch: string }
  steps: readonly JournalSqlMessage[]
  savedAt: number
}

export type JournalSqlMessagesCommit = Omit<JournalDomainItemCommit, 'outcome'> & {
  publicCursor: AgentJournalCursor
  outcomes: JournalStepOutcome[]
  failure?: JournalSqlFailure
}

export function applyJournalSqlMessageSteps(
  db: Database.Database,
  command: MessageCommand
): JournalSqlMessagesCommit {
  const { target, steps, savedAt } = command
  const head = db
    .prepare(
      'SELECT last_sequence,context_boundary FROM journal_chat_state WHERE session_id=? AND epoch=?'
    )
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal message targets a retired chat epoch')
  }
  const result: JournalSqlMessagesCommit = {
    cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
    publicCursor: {
      epoch: journalContextEpoch(target.epoch, Number(head.context_boundary)),
      sequence: Number(head.last_sequence)
    },
    outcomes: [],
    items: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  for (const step of steps) {
    db.exec('SAVEPOINT journal_message_step')
    try {
      const commit = applyJournalDomainItem(db, target, step, savedAt)
      db.exec('RELEASE journal_message_step')
      result.cursor = commit.cursor
      result.publicCursor = { ...result.publicCursor, sequence: commit.cursor.sequence }
      result.outcomes.push(commit.outcome)
      result.items.push(...commit.items)
      result.insertedItemIds ??= []
      result.insertedItemIds.push(...(commit.insertedItemIds ?? []))
      result.receipts.push(...commit.receipts)
      result.cards.push(...commit.cards)
      result.inputChanged ||= commit.inputChanged
      result.acceptedInputs = commit.acceptedInputs ?? result.acceptedInputs
      if (commit.editDeadline !== undefined) {
        result.editDeadline = commit.editDeadline
      }
    } catch (error) {
      db.exec('ROLLBACK TO journal_message_step; RELEASE journal_message_step')
      result.failure = journalSqlFailure(error)
      break
    }
  }
  return result
}
