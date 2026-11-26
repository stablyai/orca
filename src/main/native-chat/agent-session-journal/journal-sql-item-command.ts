import type Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalWriterCommand } from './journal-writer-command'
import { applyJournalDomainItem } from './journal-domain-item'
import { finishJournalSqlCommand } from './journal-sql-command-result'

/** Claims and the current item share the owning command's transaction and acknowledgement. */
export function applyJournalSqlItemCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'item' | 'item-claiming' }>
  },
  savedAt: number
) {
  const { operation, target } = command
  const result = applyJournalDomainItem(
    db,
    target,
    { ...operation, kind: 'item' },
    savedAt,
    command.facts?.stopSettle
  )
  const itemId = agentJournalItemKey(operation.identity)
  const written = result.items.find((item) => item.itemId === itemId) ?? result.items[0]
  const commit = finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    result,
    written ? { cursor: result.cursor, itemId: written.itemId, revision: written.revision } : null,
    result.outcome.kind === 'committed' && result.outcome.wrote
      ? [{ kind: 'item', epoch: target.epoch, seq: result.cursor.sequence }]
      : [],
    result.items.map((item) => item.itemId)
  )
  return commit
}
