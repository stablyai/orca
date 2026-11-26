import type Database from '../../sqlite/sync-database'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { JournalWriterCommand } from './journal-writer-command'
import { applyJournalDomainContextCommand } from './journal-domain-context-command'
import { finishJournalSqlCommand } from './journal-sql-command-result'

export function applyJournalSqlContextCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<
      JournalWriterCommand['operation'],
      {
        kind: 'context-clear' | 'context-rewind' | 'epoch-replace'
      }
    >
  },
  savedAt: number
) {
  const { operation, target } = command
  if (operation.kind === 'epoch-replace' && !operation.providerHandle && !command.facts) {
    throw new Error('journal context replacement omitted its identity facts')
  }
  const result = applyJournalDomainContextCommand(
    db,
    target,
    operation.kind === 'epoch-replace'
      ? {
          ...operation,
          providerHandle:
            operation.providerHandle ?? agentSessionJournalProviderHandle(command.facts!.identity)
        }
      : operation,
    savedAt,
    command.facts?.stopSettle
  )
  return finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    result,
    result.cursor,
    result.coordinates.map((position) => ({
      kind:
        position.kind === 'context-item' || position.kind === 'replacement-item'
          ? 'item'
          : 'tombstone',
      epoch: position.cursor.epoch,
      seq: position.cursor.sequence
    })),
    [...result.items.map((item) => item.itemId), ...result.removedItemIds]
  )
}
