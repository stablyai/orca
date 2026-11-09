import { savedRewindKeys } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type {
  JournalRewindCut,
  JournalRewindSelection
} from '../../agent-session-journal/journal-domain-rewind-cut'

export type StructuredRewindCut = JournalRewindCut

/** The SQL planner returns only the provider boundary; retained history stays on the writer. */
export function structuredRewindCut(journal: AgentSessionJournal, target: JournalRewindSelection) {
  return journal.reads.rewindCut(target)
}

/** Admission only; already-saved rewinds complete even if their target is no longer eligible. */
export async function isStructuredRewindTarget(journal: AgentSessionJournal, itemId: string) {
  return (await journal.reads.rewindTarget(itemId)).eligible
}

export async function providerItemIdOf(
  journal: AgentSessionJournal,
  itemId: string
): Promise<string> {
  const { submission } = await journal.reads.input({ kind: 'input-for-item', itemId })
  return savedRewindKeys(submission ? [submission] : []).providerKey(itemId)
}
