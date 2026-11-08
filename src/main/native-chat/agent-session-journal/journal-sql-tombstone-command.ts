import type Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { applyJournalDomainTombstone } from './journal-domain-item-removal'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import type { JournalWriterCommand } from './journal-writer-command'
import { JournalGoalAttachmentInverse } from './writing/journal-goal-attachment-inverse'

/** Goal withdrawal uses only this handle's acknowledged proof of exclusive ownership. */
export function applyJournalSqlTombstoneCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'tombstone' | 'goal-withdraw' }>
  },
  savedAt: number
) {
  const { target, operation } = command
  const result = applyJournalDomainTombstone(
    db,
    target,
    operation.kind === 'goal-withdraw' ? { ...operation, releasedUploads: [] } : operation,
    savedAt
  )
  const commit = finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    { ...result, cards: [], receipts: [], inputChanged: true },
    result.cursor,
    [{ kind: 'tombstone', epoch: target.epoch, seq: result.cursor.sequence }],
    [...result.items.map((item) => item.itemId), ...result.removedItemIds]
  )
  if (operation.kind === 'goal-withdraw') {
    const goals = new JournalGoalAttachmentInverse(target.sessionId)
    if (command.facts?.goals) {
      goals.adopt(command.facts.goals)
    }
    const withdrawal = goals.withdraw(agentJournalItemKey(operation.identity))
    withdrawal.write?.(db)
    withdrawal.committed?.()
    commit.goals = goals.snapshot()
  }
  return commit
}
