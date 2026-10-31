import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'
import { questionDependency } from '../agent-session-journal/journal-question-dependency'
export { questionDependency } from '../agent-session-journal/journal-question-dependency'

export function unchangedQuestionDependencies(
  journal: StructuredAgentSessionCurrentWorkJournal,
  from: AgentJournalCursor,
  through: AgentJournalCursor,
  dependencies: Map<string, string>,
  scoped: boolean
): boolean {
  if (from.epoch !== through.epoch || from.sequence > through.sequence) {
    return false
  }
  let cursor = from
  const changed = new Set<string>()
  while (cursor.sequence < through.sequence) {
    const delta = journal.readSince(cursor, 256)
    if (!delta.ok) {
      return false
    }
    let sequence = cursor.sequence
    for (const row of delta.rows) {
      if (row.seq > through.sequence) {
        break
      }
      if (row.seq !== sequence + 1 || row.kind !== 'item') {
        return false
      }
      sequence = row.seq
      changed.add(journal.questionSourceFacts().canonicalItemId(row.itemId))
    }
    if (sequence === cursor.sequence) {
      return false
    }
    cursor = { epoch: through.epoch, sequence }
  }
  const next = new Map<string, string>()
  for (const id of changed) {
    const item = journal.item(id)
    if (!item) {
      return false
    }
    const value = questionDependency(item)
    // Adding the first scope or removing scope support requires the canonical ownership fold.
    const prior = dependencies.get(id)
    const irrelevant =
      (prior === undefined || prior === value || (prior === 'false' && scoped)) &&
      (value === 'false' || (value === 'true' && scoped))
    if (!irrelevant && prior !== value) {
      return false
    }
    next.set(id, value)
  }
  for (const [id, value] of next) {
    dependencies.set(id, value)
  }
  return true
}
