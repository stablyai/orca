import type Database from '../../sqlite/sync-database'
import type { JournalSqlBatch, JournalSqlBatchResult } from './journal-sql-batch'
import {
  applyJournalDomainItem,
  type JournalDomainItemWrite,
  type JournalDomainItemCommit
} from './journal-domain-item'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStepOutcome } from './writing/journal-writer-step'
import { journalTextSnapshotPosition } from './writing/journal-text-snapshot-position'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'

export type JournalSqlMessage = JournalDomainItemWrite & { body: AgentJournalMessageItem }

type MessageCommand = {
  target: { sessionId: string; epoch: string }
  steps: readonly JournalSqlMessage[]
  savedAt: number
}

export type JournalSqlMessageJob = {
  command: MessageCommand
  bytes: number
}

export type JournalSqlMessagesCommit = Omit<JournalDomainItemCommit, 'outcome'> & {
  outcomes: JournalStepOutcome[]
  failure?: JournalSqlFailure
}

/** Sender work; the writer drains the already classified and sized command. */
export function prepareJournalSqlMessages(command: MessageCommand): JournalSqlMessageJob {
  return {
    command,
    bytes: Buffer.byteLength(JSON.stringify(command), 'utf8')
  }
}

/** Called by the existing writer admission lane; publication completes before the next drain. */
export async function commitJournalSqlMessages(
  db: Database.Database,
  batch: JournalSqlBatch,
  jobs: readonly JournalSqlMessageJob[],
  publish: (commit: JournalSqlMessagesCommit, index: number) => void
): Promise<JournalSqlBatchResult<JournalSqlMessagesCommit>> {
  const result = await batch.run(jobs, (job) => applyMessageSteps(db, job))
  for (const [index, outcome] of result.outcomes.entries()) {
    if (outcome.committed) {
      publish(outcome.value, index)
    }
  }
  return result
}

function applyMessageSteps(
  db: Database.Database,
  job: JournalSqlMessageJob
): JournalSqlMessagesCommit {
  const { target, steps, savedAt } = job.command
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal message targets a retired chat epoch')
  }
  const result: JournalSqlMessagesCommit = {
    cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
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
      const item = commit.items[0]
      result.outcomes.push(
        commit.outcome.kind === 'committed' && item
          ? { ...commit.outcome, position: journalTextSnapshotPosition(item) }
          : commit.outcome
      )
      result.items.push(...commit.items)
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
