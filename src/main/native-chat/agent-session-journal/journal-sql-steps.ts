import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import type { JournalWriterSession } from './journal-writer-session'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalStepsResult } from './writing/journal-writer-step'

/** A failed step discards its whole session; only successful sessions contribute to the prefix. */
export async function runJournalSqlSteps(
  db: Database.Database,
  command: JournalWriterCommand & { operation: { kind: 'steps' } },
  initialFacts: JournalWriterHostFacts,
  createSession: (facts: JournalWriterHostFacts) => JournalWriterSession
): Promise<JournalWriterCommit> {
  if (command.effects) {
    throw new Error('journal step commands carry no host receipt')
  }
  const result: JournalStepsResult = { outcomes: [] }
  const commits: JournalWriterCommit[] = []
  let facts = initialFacts
  if (command.operation.dropped) {
    result.outcomes = command.operation.steps.map(() => ({ kind: 'dropped' }))
  } else {
    for (const step of command.operation.steps) {
      db.exec('SAVEPOINT journal_step')
      try {
        const session = createSession(facts)
        const outcome = session.collaborators.stepWriter.write({ kind: 'command', step })
        const { rows: _rows, goals, ...commit } = await session.finish()
        db.exec('RELEASE journal_step')
        commits.push({ ...commit, effects: [], ...(facts.goals ? { goals } : {}) })
        facts = { ...facts, goals }
        result.outcomes.push(outcome)
      } catch (error) {
        db.exec('ROLLBACK TO journal_step; RELEASE journal_step')
        result.failure = journalSqlFailure(error)
        break
      }
    }
  }
  // Even an empty, dropped or failed-first command must prove target ownership and coverage.
  const { rows: _rows, goals, ...final } = await createSession(facts).finish()
  const keys = new Map<string, JournalWriterCommit['keys'][number]>()
  const items = new Map<string, JournalWriterCommit['items'][number]>()
  const inputKeys = new Map<string, boolean>()
  for (const commit of commits) {
    for (const key of commit.keys) {
      keys.set(JSON.stringify([key.collection, key.key]), key)
    }
    for (const item of commit.items) {
      items.set(item.itemId, item)
    }
    for (const [key, present] of commit.inputKeys) {
      if (!inputKeys.has(key)) {
        inputKeys.set(key, present)
      }
    }
  }
  const withdrewCut = commits.findLast((commit) => commit.withdrewCut)?.withdrewCut
  return {
    ...final,
    keys: [...keys.values()],
    items: [...items.values()],
    inputKeys: [...inputKeys],
    inputChanged: commits.some((commit) => commit.inputChanged),
    effects: [],
    value: result,
    ...(withdrewCut ? { withdrewCut } : {}),
    ...(command.facts?.goals ? { goals } : {})
  }
}
