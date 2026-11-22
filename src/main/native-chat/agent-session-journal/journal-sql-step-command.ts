import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import { runJournalSqlSteps, journalSqlTextSteps } from './journal-sql-steps'
import { applyJournalSqlMessageSteps } from './journal-sql-message-commit'

/** Sparse text snapshots keep their body-free message route and never invalidate their stream. */
export function applyJournalSqlStepCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'steps' }>
  },
  savedAt: number
) {
  if (command.effects) {
    throw new Error('journal steps carry no receipt')
  }
  const { operation, target } = command
  const text = journalSqlTextSteps(operation.steps)
  if (!text) {
    const result = runJournalSqlSteps(db, command, savedAt)
    return finishJournalSqlCommand(
      db,
      stateDirectory,
      command,
      result,
      result.value,
      result.coordinates,
      result.invalidatedItemIds ?? []
    )
  }
  const result = applyJournalSqlMessageSteps(db, {
    target,
    steps: operation.dropped ? [] : text,
    savedAt
  })
  if (operation.dropped) {
    result.outcomes = text.map(() => ({ kind: 'dropped' }))
  }
  return finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    result,
    {
      outcomes: result.outcomes,
      cursor: result.cursor,
      items: result.items,
      ...(result.failure ? { failure: result.failure } : {})
    },
    []
  )
}
